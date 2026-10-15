package expo.modules.aiwbnet

import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.CertPathValidatorException
import java.security.cert.CertificateException
import java.security.cert.CertificateExpiredException
import java.security.cert.CertificateNotYetValidException
import java.security.cert.PKIXReason
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManager
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/** A certificate the trust rule refused: thrown by a trust manager inside the handshake, found again by [problemOf]
 *  in the cause chain of whatever the TLS stack wraps it in. */
class TrustFailure(val failure: NetFailure) : CertificateException(failure.outcome)

/** The SHA-256 of a DER certificate: upper-case hex pairs joined by ":" (`fingerprintOf` of packages/conn/core). */
fun fingerprintOf(cert: X509Certificate): String =
  MessageDigest.getInstance("SHA-256").digest(cert.encoded).joinToString(":") { "%02X".format(it) }

/**
 * The trust of every connection of the module (README.md, "The trust rule"): the one place a certificate is judged. It
 * runs inside the handshake, so a refused certificate ends the handshake before any application byte is written.
 * [presented] is the fingerprint of the leaf of the last handshake that reached it.
 */
abstract class AiwbTrust : X509TrustManager {
  @Volatile var presented: String = ""

  override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
    throw CertificateException("no client certificates")
  }

  override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
    val leaf = chain?.firstOrNull() ?: throw CertificateException("the server presented no certificate")
    presented = fingerprintOf(leaf)
    judge(leaf, chain, authType ?: "RSA")
  }

  override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()

  /** Throws a [TrustFailure] unless the leaf is accepted. */
  protected abstract fun judge(leaf: X509Certificate, chain: Array<out X509Certificate>, authType: String)

  fun socketFactory(): SSLSocketFactory {
    val ctx = SSLContext.getInstance("TLS")
    ctx.init(null, arrayOf<TrustManager>(this), null)
    return ctx.socketFactory
  }
}

/** `selfSigned: true`: the leaf whose fingerprint, as text, equals [pin], and no other certificate. Nothing else is
 *  checked: not the chain, not the dates, not the name, not the system's roots. */
class PinTrust(private val pin: String) : AiwbTrust() {
  override fun judge(leaf: X509Certificate, chain: Array<out X509Certificate>, authType: String) {
    if (presented != pin) {
      throw TrustFailure(NetFailure.problem("cert_changed", "the certificate is not the one that was accepted", presented, pin))
    }
  }
}

/** `readCertificate`: takes any certificate, to read its fingerprint. Nothing is written on such a connection. */
class AnyTrust : AiwbTrust() {
  override fun judge(leaf: X509Certificate, chain: Array<out X509Certificate>, authType: String) {}
}

/**
 * `selfSigned: false`: the platform's own evaluation, named in the order the Node connector uses: the name
 * (`cert_name`), the dates (`cert_expired`), a certificate with no root that is self-signed (`self_signed`), then
 * anything else (`cert_untrusted`).
 */
class PlatformTrust(private val host: String) : AiwbTrust() {
  private val system: X509TrustManager = run {
    val f = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
    f.init(null as KeyStore?)
    f.trustManagers.filterIsInstance<X509TrustManager>().first()
  }

  override fun judge(leaf: X509Certificate, chain: Array<out X509Certificate>, authType: String) {
    if (!nameFits(host, leaf)) throw TrustFailure(NetFailure.problem("cert_name", "the certificate is not for $host"))
    try {
      leaf.checkValidity()
    } catch (e: CertificateExpiredException) {
      throw TrustFailure(NetFailure.problem("cert_expired", "the certificate has expired"))
    } catch (e: CertificateNotYetValidException) {
      throw TrustFailure(NetFailure.problem("cert_expired", "the certificate is not valid yet"))
    }
    try {
      system.checkServerTrusted(chain.copyOf(), authType)
    } catch (e: CertificateException) {
      val selfIssued = leaf.subjectX500Principal == leaf.issuerX500Principal
      var noRoot = false
      var t: Throwable? = e
      while (t != null) {
        if (t is CertPathValidatorException && t.reason == PKIXReason.NO_TRUST_ANCHOR) noRoot = true
        t = t.cause
      }
      throw TrustFailure(
        if (selfIssued || (noRoot && chain.size == 1)) NetFailure.problem("self_signed", "the certificate is self-signed and no root vouches for it")
        else NetFailure.problem("cert_untrusted", oneLine(e)),
      )
    }
  }
}

/** Whether [leaf] is for [host]: a dNSName or iPAddress of the subject alternative names (a `*.` label matches one label),
 *  else the common name when there are no names at all. */
fun nameFits(host: String, leaf: X509Certificate): Boolean {
  val h = host.lowercase().trimEnd('.')
  val names = try { leaf.subjectAlternativeNames } catch (_: CertificateException) { null }
  val dns = names?.filter { it.size >= 2 && it[0] == 2 }?.map { it[1].toString().lowercase().trimEnd('.') }.orEmpty()
  val ips = names?.filter { it.size >= 2 && it[0] == 7 }?.map { it[1].toString().lowercase() }.orEmpty()
  if (ips.contains(h)) return true
  if (dns.any { matchesName(h, it) }) return true
  if (names != null && (dns.isNotEmpty() || ips.isNotEmpty())) return false
  val cn = Regex("CN=([^,]+)", RegexOption.IGNORE_CASE).find(leaf.subjectX500Principal.name)?.groupValues?.get(1)?.lowercase()
  return cn != null && matchesName(h, cn)
}

private fun matchesName(host: String, pattern: String): Boolean {
  if (!pattern.startsWith("*.")) return host == pattern
  val rest = pattern.substring(1) // ".example.com"
  val dot = host.indexOf('.')
  return dot > 0 && host.substring(dot) == rest
}

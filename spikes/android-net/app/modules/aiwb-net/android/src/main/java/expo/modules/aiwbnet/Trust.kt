package expo.modules.aiwbnet

import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.X509TrustManager

/** Every failure the module reports: [outcome] is an outcome of desktop/conn/outcomes.js (or a NetError code of
 *  session.js: timeout, reset, too_long, closed, plus aborted), [detail] the network's text. */
class Failure(
  val outcome: String,
  val detail: String = "",
  val fingerprint: String = "",
  val pinned: String = "",
) : Exception(outcome)

/** The certificate did not match the pin: thrown by the trust manager inside the handshake. */
class PinMismatch(val presented: String, val pinned: String) : CertificateException("certificate_changed")

/** The SHA-256 of a DER certificate: uppercase hex pairs joined by ":" (desktop/conn/tls.js fingerprintOf). */
fun fingerprintOf(cert: X509Certificate): String =
  MessageDigest.getInstance("SHA-256").digest(cert.encoded)
    .joinToString(":") { "%02X".format(it) }

private val HEX64 = Regex("^[0-9a-fA-F]{64}$")

/** desktop/conn/list.js normalFingerprint: null when s is no fingerprint. */
fun normalFingerprint(s: String?): String? {
  val h = (s ?: return null).trim().replace(":", "")
  if (!HEX64.matches(h)) return null
  return h.uppercase().chunked(2).joinToString(":")
}

/**
 * The one trust rule: the leaf certificate is accepted if and only if its SHA-256 fingerprint equals the pin.
 * No chain, no dates, no name, no system roots. With [pin] null every certificate is taken (used only by
 * readCertificate, which sends nothing). It runs inside the handshake, so a refused certificate ends the handshake
 * before any application byte is written.
 */
class PinTrust(pin: String?) : X509TrustManager {
  /** The pin in its normal form; "" is a pin that no certificate fits (a pin that is no fingerprint). */
  private val pinned: String? = if (pin == null) null else (normalFingerprint(pin) ?: "")
  private val rawPin = pin

  @Volatile var presented: String = ""

  override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
    throw CertificateException("no client certificates")
  }

  override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
    val leaf = chain?.firstOrNull() ?: throw CertificateException("the server presented no certificate")
    val fp = fingerprintOf(leaf)
    presented = fp
    if (pinned != null && pinned != fp) throw PinMismatch(fp, if (pinned == "") rawPin ?: "" else pinned)
  }

  override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()

  fun socketFactory(): SSLSocketFactory {
    val ctx = SSLContext.getInstance("TLS")
    ctx.init(null, arrayOf(this), null)
    return ctx.socketFactory
  }
}

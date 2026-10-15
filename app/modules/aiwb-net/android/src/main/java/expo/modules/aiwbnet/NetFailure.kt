package expo.modules.aiwbnet

import org.json.JSONObject

/**
 * What a failed call says: the `NetErr` of src/AiwbNet.ts. [kind] is "problem" (why no session was made:
 * [outcome] is an outcome of packages/conn/core/outcomes.js), "net" (why a request got no usable answer: [outcome] is
 * the code `timeout`, `reset`, `too_long` or `closed`) or "aborted" (what `cancel` does).
 */
class NetFailure(
  val kind: String,
  val outcome: String = "",
  val detail: String = "",
  val fingerprint: String? = null,
  val pinned: String? = null,
) : Exception(if (kind == "aborted") "aborted" else "$kind $outcome") {
  /** The JSON text of the NetErr. It is the message of the rejection: Expo's bridge has no place for a structured `info`,
   *  and `netInfoOf` (src/AiwbNet.ts) reads the object that ends the message. */
  fun json(): String {
    val o = JSONObject().put("kind", kind)
    when (kind) {
      "problem" -> {
        o.put("outcome", outcome).put("detail", detail)
        if (fingerprint != null) o.put("fingerprint", fingerprint)
        if (pinned != null) o.put("pinned", pinned)
      }
      "net" -> {
        o.put("code", outcome)
        if (detail.isNotEmpty()) o.put("detail", detail)
      }
    }
    return o.toString()
  }

  companion object {
    fun problem(outcome: String, detail: String = "", fingerprint: String? = null, pinned: String? = null) =
      NetFailure("problem", outcome, detail, fingerprint, pinned)

    fun net(code: String, detail: String = "") = NetFailure("net", code, detail)

    fun aborted() = NetFailure("aborted")
  }
}

/** One line of the platform's text, for the user to see. */
fun oneLine(e: Throwable): String = (e.message ?: e.toString()).replace(Regex("\\s+"), " ").trim().take(300)

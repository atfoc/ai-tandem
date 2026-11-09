package expo.modules.aiwbindent

import android.graphics.Canvas
import android.graphics.Paint
import android.text.Editable
import android.text.Layout
import android.text.NoCopySpan
import android.text.Spanned
import android.text.TextUtils
import android.text.TextWatcher
import android.text.style.LeadingMarginSpan
import android.text.style.TabStopSpan
import android.text.style.UpdateLayout
import android.view.View
import android.view.ViewTreeObserver
import android.widget.EditText
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.lang.ref.WeakReference
import java.util.WeakHashMap
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.min
import kotlin.math.roundToInt

// The Android side of `aiwb-indent`: the hanging indent of the composer's text box. When a line of the box wraps, its continuation
// lines start where its text starts after its leading tabs and spaces, and a tab is drawn `tabWidth` columns wide. The contract is
// src/AiwbIndent.ts (the rules `indentColumns`, `paragraphs`, `hangWidth`, `tabInterval`, which the code below follows exactly); how
// it is used is README.md at the root of the module and app/src/platform/chipinput/hang.ts.
//
// Why it is done this way. The box is React Native's TextInput, a ReactEditText. Its text is spans the module adds: a HangSpan (a
// LeadingMarginSpan: no margin on a paragraph's first line, the hang on the others) on each indented paragraph and TabStop spans on
// each paragraph that holds a tab. They must be there after every change of the text, also the changes JS makes, and RN does not
// tell of those: `ReactEditText.maybeSetText` puts JS's text in with `Editable.replace` (its `manageSpans` removes its own spans and
// keeps, SPAN_EXCLUSIVE_EXCLUSIVE, only those over text that did not change), and it calls the TextWatchers added with
// `addTextChangedListener` only for the user's edits, not while it sets the text from JS. A TextWatcher put on the Editable itself as
// a span, though, is told of every change by SpannableStringBuilder, JS's included, and outlives `replace` (SPAN_INCLUSIVE_INCLUSIVE
// has none of the EXCLUSIVE_EXCLUSIVE bits manageSpans looks for). Its priority (200) is above that of TextView's own ChangeWatcher
// (100), so in `onTextChanged` the spans are set before the DynamicLayout reflows the change and before React Native's listener copies
// the text, spans and all, into the cache it measures from. An empty text from JS is `setText(null)`, which makes a new Editable:
// the Editable.Factory set on the EditText puts the watcher on every new one.
//
// Both spans implement UpdateLayout: DynamicLayout reflows on the adding or removing of a span only for those. Without it a
// LeadingMarginSpan added outside a change of the text (the tab width changed) did not move the line breaks, and the text ran past
// the right edge (found in the prototype). The spans are applied as a diff (a span already there with the same place and value is
// kept), so a keystroke reflows only the paragraphs whose indent changed.
//
// React Native measures the box from JS's attributed string after an update made from JS (Enter, Tab, a set), without these spans,
// so its height can be wrong; the module emits the height of the text as drawn (`onDrawnHeight`, in dp as JS counts, padding
// included) before each frame it changed in, and the field takes it as its height.
//
// Everything here runs on the main thread (`setIndent` runs on Queues.MAIN; the watcher and the listeners are called there).

/** The share of the text's width an indent may take at most (src/AiwbIndent.ts MAX_INDENT_SHARE; app/test/aiwbindent.native.test.ts
 *  compares the two). */
const val MAX_INDENT_SHARE = 0.5f

/** The priority of the watcher span: above TextView's ChangeWatcher (100), so it is told of a change before the layout is. */
const val WATCHER_PRIORITY = 200

/** At most this many tab stops on a paragraph (the stops cover the text's width; this many when the width is not known yet). */
const val MAX_TAB_STOPS = 64

/** The columns of a line's indent (src/AiwbIndent.ts `indentColumns`): its leading spaces and tabs from `start` to `end`, a space
 *  one column, a tab up to the next multiple of `tabWidth`; stops at the first other character. */
fun indentColumns(text: CharSequence, start: Int, end: Int, tabWidth: Int): Int {
  var cols = 0
  var i = start
  while (i < end) {
    val c = text[i]
    if (c == ' ') cols += 1 else if (c == '\t') cols += tabWidth - cols % tabWidth else break
    i++
  }
  return cols
}

/** How far the continuation lines start (src/AiwbIndent.ts `hangWidth`): the columns times the width of a space, at most
 *  MAX_INDENT_SHARE of the text's width; no cap while the width is not known (0 or less). */
fun hangWidth(columns: Int, spaceWidth: Float, textWidth: Float): Float {
  val w = columns * spaceWidth
  return if (textWidth > 0) min(w, textWidth * MAX_INDENT_SHARE) else w
}

/** The distance between two tab stops (src/AiwbIndent.ts `tabInterval`): `tabWidth` spaces of the font. */
fun tabInterval(tabWidth: Int, spaceWidth: Float): Float = tabWidth * spaceWidth

/** The hang of a paragraph: its first line where its own spaces and tabs put it, the others `px` from the left edge. Draws nothing. */
class HangSpan(val px: Int) : LeadingMarginSpan, UpdateLayout {
  override fun getLeadingMargin(first: Boolean): Int = if (first) 0 else px
  override fun drawLeadingMargin(
    c: Canvas, p: Paint, x: Int, dir: Int, top: Int, baseline: Int, bottom: Int,
    text: CharSequence, start: Int, end: Int, first: Boolean, layout: Layout?,
  ) {}
}

/** One tab stop of a paragraph, `at` pixels from the left edge. */
class TabStop(val at: Int) : TabStopSpan, UpdateLayout {
  override fun getTabStop(): Int = at
}

/** The indent of one EditText: the watcher span on its Editable, the spans, the listeners of its width and of its drawn height.
 *  It holds the view weakly (the module's map holds it). As a span it is a NoCopySpan, like TextView's own ChangeWatcher: a copy of
 *  the text (React Native's measuring cache, the clipboard) takes the HangSpans and TabStops but not the watcher. */
class Indenter(
  view: EditText,
  val tag: Int,
  var tabWidth: Int,
  private val emit: (Map<String, Any?>) -> Unit,
  private val onGone: (Indenter) -> Unit,
) : TextWatcher, NoCopySpan, View.OnLayoutChangeListener, ViewTreeObserver.OnPreDrawListener {
  private val viewRef = WeakReference(view)
  private val view: EditText? get() = viewRef.get()
  private var busy = false
  private var lastHeight = -1f
  private var attached = false

  /** Every new Editable of the view (`setText`, `setText(null)` for an empty text from JS) gets the watcher and the spans. */
  private val factory = object : Editable.Factory() {
    override fun newEditable(source: CharSequence): Editable {
      val e = super.newEditable(source)
      if (attached) {
        watch(e)
        reapply(e)
      }
      return e
    }
  }

  /** Whether the view is still the one of our tag (React Native's view id is the React tag). */
  private fun current(v: EditText): Boolean = v.id == tag

  fun attach() {
    val v = view ?: return
    attached = true
    v.setEditableFactory(factory)
    v.addOnLayoutChangeListener(this)
    v.viewTreeObserver.addOnPreDrawListener(this)
    v.text?.let { watch(it); reapply(it) }
    v.invalidate()
  }

  fun setTab(w: Int) {
    if (w == tabWidth) return
    tabWidth = w
    view?.let { v -> v.text?.let { reapply(it) }; v.invalidate() }
  }

  /** Takes everything off the view and gives it React Native's own drawing back. */
  fun detach() {
    attached = false
    val v = view ?: return
    v.text?.let { unwatch(it) }
    v.removeOnLayoutChangeListener(this)
    try {
      v.viewTreeObserver.removeOnPreDrawListener(this)
    } catch (e: IllegalStateException) {
      // The observer was no longer alive: the listener went with it.
    }
    v.setEditableFactory(Editable.Factory.getInstance())
  }

  private fun watch(e: Editable) {
    if (e.getSpans(0, e.length, Indenter::class.java).any { it === this }) return
    e.setSpan(this, 0, e.length, Spanned.SPAN_INCLUSIVE_INCLUSIVE or (WATCHER_PRIORITY shl Spanned.SPAN_PRIORITY_SHIFT))
  }

  private fun unwatch(e: Editable) {
    e.removeSpan(this)
    for (s in e.getSpans(0, e.length, HangSpan::class.java)) e.removeSpan(s)
    for (s in e.getSpans(0, e.length, TabStop::class.java)) e.removeSpan(s)
  }

  /** Puts the spans the text wants (src/AiwbIndent.ts `paragraphs`) as a diff of those it has: a span of ours with the same place
   *  and value stays, the others go, the missing ones are added. */
  fun reapply(e: Editable) {
    val v = view ?: return
    if (busy || !attached) return
    busy = true
    try {
      val space = v.paint.measureText(" ")
      val textWidth = (v.width - v.totalPaddingLeft - v.totalPaddingRight).toFloat()
      val px = { cols: Int -> hangWidth(cols, space, textWidth).roundToInt() }
      val interval = tabInterval(tabWidth, space)
      val stops = if (interval < 1f) 0 else if (textWidth > 0) min(MAX_TAB_STOPS, ceil(textWidth / interval).toInt()) else MAX_TAB_STOPS

      // What is there now, by class, place and value.
      val have = HashMap<String, Any>()
      for (s in e.getSpans(0, e.length, HangSpan::class.java)) have["h:${e.getSpanStart(s)}:${e.getSpanEnd(s)}:${s.px}"] = s
      for (s in e.getSpans(0, e.length, TabStop::class.java)) have["t:${e.getSpanStart(s)}:${e.getSpanEnd(s)}:${s.at}"] = s
      val add = ArrayList<Triple<Any, Int, Int>>()

      var start = 0
      while (start < e.length) {
        val nl = TextUtils.indexOf(e, '\n', start)
        val end = if (nl < 0) e.length else nl + 1
        val cols = indentColumns(e, start, end, tabWidth)
        if (cols > 0) {
          val w = px(cols)
          if (have.remove("h:$start:$end:$w") == null) add.add(Triple(HangSpan(w), start, end))
        }
        if (TextUtils.indexOf(e, '\t', start, end) >= 0) {
          for (k in 1..stops) {
            val at = (k * interval).roundToInt()
            if (have.remove("t:$start:$end:$at") == null) add.add(Triple(TabStop(at), start, end))
          }
        }
        start = end
      }
      for (s in have.values) e.removeSpan(s)
      for ((s, a, b) in add) e.setSpan(s, a, b, Spanned.SPAN_PARAGRAPH)
    } finally {
      busy = false
    }
  }

  // The watcher: in onTextChanged, before the layout reflows the change (WATCHER_PRIORITY).
  override fun beforeTextChanged(s: CharSequence, start: Int, count: Int, after: Int) {}
  override fun onTextChanged(s: CharSequence, start: Int, before: Int, count: Int) {
    if (s is Editable) reapply(s)
  }
  override fun afterTextChanged(s: Editable) {}

  // A new width changes the cap of the hang and the number of tab stops.
  override fun onLayoutChange(v: View, l: Int, t: Int, r: Int, b: Int, ol: Int, ot: Int, or: Int, ob: Int) {
    val et = view ?: return
    if (!current(et)) { onGone(this); return }
    if (r - l != or - ol) et.text?.let { reapply(it) }
  }

  // Before each frame: the height of the text as drawn, in dp, emitted when it changed by half a dp or more.
  override fun onPreDraw(): Boolean {
    val v = view ?: return true
    if (!current(v)) { onGone(this); return true }
    val layout = v.layout ?: return true
    val h = (layout.height + v.totalPaddingTop + v.totalPaddingBottom) / v.resources.displayMetrics.density
    if (abs(h - lastHeight) >= 0.5f) {
      lastHeight = h
      emit(mapOf("tag" to tag, "height" to h.toDouble()))
    }
    return true
  }
}

class AiwbIndentModule : Module() {
  private val indenters = WeakHashMap<EditText, Indenter>()

  /** Takes the indenter off its view and forgets it (by value: the indenter must not hold its view strongly, nor a lambda of it). */
  private fun drop(ind: Indenter) {
    ind.detach()
    indenters.entries.removeAll { it.value === ind }
  }

  override fun definition() = ModuleDefinition {
    Name("AiwbIndent")

    Events("onDrawnHeight")

    // The contract is src/AiwbIndent.ts `setIndent`: true when the view was found (and the indent is now as asked), false when it
    // was not. Never throws (a tag no surface knows makes Fabric's resolveView throw: that is "not found").
    AsyncFunction("setIndent") { tag: Int, tabWidth: Int ->
      val view = try {
        appContext.findView<View>(tag) as? EditText
      } catch (e: Exception) {
        null
      } ?: return@AsyncFunction false
      var ind = indenters[view]
      if (ind != null && ind.tag != tag) {
        drop(ind)
        ind = null
      }
      if (tabWidth <= 0) {
        if (ind != null) drop(ind)
        return@AsyncFunction true
      }
      if (ind != null) {
        ind.setTab(tabWidth)
        return@AsyncFunction true
      }
      val made = Indenter(
        view, tag, tabWidth,
        emit = { body -> sendEvent("onDrawnHeight", body) },
        onGone = { gone -> drop(gone) },
      )
      indenters[view] = made
      made.attach()
      true
    }.runOnQueue(Queues.MAIN)
  }
}

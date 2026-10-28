package expo.modules.aiwbkeys

import android.app.Activity
import android.os.Build
import android.view.ActionMode
import android.view.KeyEvent
import android.view.KeyboardShortcutGroup
import android.view.Menu
import android.view.MenuItem
import android.view.MotionEvent
import android.view.SearchEvent
import android.view.View
import android.view.Window
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// The Android side of `aiwb-keys` (package N3, AD-73): the hardware keyboard's shortcuts of the desktop page, taken in the
// dispatchKeyEvent of the activity's window (the first place a key is offered, before the focused view and the keyboard of the
// system) and emitted as "onKey". While nobody listens the window's own callback is put back. The contract it implements is
// README.md at the root of the module; the TypeScript of it is src/AiwbKeys.ts.

/** One shortcut the module takes. The list below is the one of src/AiwbKeys.ts `SHORTCUTS` (app/test/nativekeys.test.ts compares them). */
data class Shortcut(val code: String, val key: String, val mod: Boolean, val shift: Boolean, val label: String) {
  /** The Android key code of the shortcut's key. */
  val keyCode: Int
    get() = when (code) {
      "Enter" -> KeyEvent.KEYCODE_ENTER
      "Escape" -> KeyEvent.KEYCODE_ESCAPE
      else -> KeyEvent.KEYCODE_A + (code.last() - 'A')
    }

  /** The event's `key`: a letter is upper case with Shift, as a browser makes it. */
  val eventKey: String get() = if (shift && key.length == 1 && key[0].isLetter()) key.uppercase() else key
}

val shortcuts = listOf(
  Shortcut(code = "KeyN", key = "n", mod = true, shift = false, label = "New chat"),
  Shortcut(code = "KeyB", key = "b", mod = true, shift = false, label = "Hide or show the sidebar"),
  Shortcut(code = "KeyB", key = "b", mod = true, shift = true, label = "Tree of the chat"),
  Shortcut(code = "KeyJ", key = "j", mod = true, shift = false, label = "Hide or show the chat panel"),
  Shortcut(code = "KeyL", key = "l", mod = true, shift = false, label = "Quote the selection or add it to the message"),
  Shortcut(code = "KeyL", key = "l", mod = true, shift = true, label = "Pick a point on the board"),
  Shortcut(code = "KeyP", key = "p", mod = true, shift = false, label = "Insert a prompt"),
  Shortcut(code = "KeyE", key = "e", mod = true, shift = false, label = "Model and effort"),
  Shortcut(code = "Enter", key = "Enter", mod = true, shift = false, label = "Save"),
  Shortcut(code = "Escape", key = "Escape", mod = false, shift = false, label = "Close"),
)

/** The shortcut an event is, or null: Ctrl for `mod` (the Meta key and Alt are not part of any), exactly the Shift the shortcut has. */
fun shortcutOf(event: KeyEvent): Shortcut? {
  if (event.isAltPressed || event.isMetaPressed) return null
  val keyCode = if (event.keyCode == KeyEvent.KEYCODE_NUMPAD_ENTER) KeyEvent.KEYCODE_ENTER else event.keyCode
  return shortcuts.firstOrNull { it.keyCode == keyCode && it.mod == event.isCtrlPressed && it.shift == event.isShiftPressed }
}

/**
 * The window's callback with dispatchKeyEvent changed: a key down of a shortcut is emitted and taken (so the focused view does not
 * also get it), its key up with it; every other key, and every other call, is the callback it wraps. Written out, not `by`: a
 * Java interface's default methods (onProvideKeyboardShortcuts, onPointerCaptureChanged, ...) are not delegated by `by`.
 */
class KeysWindowCallback(val wrapped: Window.Callback, private val emit: (Map<String, Any?>) -> Unit) : Window.Callback {
  /** The key codes whose key down was taken and whose key up has not come yet. */
  private val taken = HashSet<Int>()

  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    if (event.action == KeyEvent.ACTION_UP && taken.remove(event.keyCode)) return true
    if (event.action == KeyEvent.ACTION_DOWN) {
      val s = shortcutOf(event)
      if (s != null) {
        taken.add(event.keyCode)
        emit(mapOf(
          "key" to s.eventKey, "code" to s.code,
          "metaKey" to false, "ctrlKey" to s.mod, "shiftKey" to s.shift, "altKey" to false,
          "repeat" to (event.repeatCount > 0),
        ))
        return true
      }
    }
    return wrapped.dispatchKeyEvent(event)
  }

  override fun dispatchKeyShortcutEvent(event: KeyEvent): Boolean = wrapped.dispatchKeyShortcutEvent(event)
  override fun dispatchTouchEvent(event: MotionEvent): Boolean = wrapped.dispatchTouchEvent(event)
  override fun dispatchTrackballEvent(event: MotionEvent): Boolean = wrapped.dispatchTrackballEvent(event)
  override fun dispatchGenericMotionEvent(event: MotionEvent): Boolean = wrapped.dispatchGenericMotionEvent(event)
  override fun dispatchPopulateAccessibilityEvent(event: AccessibilityEvent): Boolean = wrapped.dispatchPopulateAccessibilityEvent(event)
  override fun onCreatePanelView(featureId: Int): View? = wrapped.onCreatePanelView(featureId)
  override fun onCreatePanelMenu(featureId: Int, menu: Menu): Boolean = wrapped.onCreatePanelMenu(featureId, menu)
  override fun onPreparePanel(featureId: Int, view: View?, menu: Menu): Boolean = wrapped.onPreparePanel(featureId, view, menu)
  override fun onMenuOpened(featureId: Int, menu: Menu): Boolean = wrapped.onMenuOpened(featureId, menu)
  override fun onMenuItemSelected(featureId: Int, item: MenuItem): Boolean = wrapped.onMenuItemSelected(featureId, item)
  override fun onWindowAttributesChanged(attrs: WindowManager.LayoutParams?) = wrapped.onWindowAttributesChanged(attrs)
  override fun onContentChanged() = wrapped.onContentChanged()
  override fun onWindowFocusChanged(hasFocus: Boolean) = wrapped.onWindowFocusChanged(hasFocus)
  override fun onAttachedToWindow() = wrapped.onAttachedToWindow()
  override fun onDetachedFromWindow() = wrapped.onDetachedFromWindow()
  override fun onPanelClosed(featureId: Int, menu: Menu) = wrapped.onPanelClosed(featureId, menu)
  override fun onSearchRequested(): Boolean = wrapped.onSearchRequested()
  override fun onSearchRequested(searchEvent: SearchEvent?): Boolean = wrapped.onSearchRequested(searchEvent)
  override fun onWindowStartingActionMode(callback: ActionMode.Callback?): ActionMode? = wrapped.onWindowStartingActionMode(callback)
  override fun onWindowStartingActionMode(callback: ActionMode.Callback?, type: Int): ActionMode? = wrapped.onWindowStartingActionMode(callback, type)
  override fun onActionModeStarted(mode: ActionMode?) = wrapped.onActionModeStarted(mode)
  override fun onActionModeFinished(mode: ActionMode?) = wrapped.onActionModeFinished(mode)
  override fun onProvideKeyboardShortcuts(data: MutableList<KeyboardShortcutGroup>?, menu: Menu?, deviceId: Int) {
    wrapped.onProvideKeyboardShortcuts(data, menu, deviceId)
  }
  override fun onPointerCaptureChanged(hasCapture: Boolean) { wrapped.onPointerCaptureChanged(hasCapture) }
}

class AiwbKeysModule : Module() {
  private var listening = false
  private var installed: Pair<Window, KeysWindowCallback>? = null

  private fun emit(event: Map<String, Any?>) = sendEvent("onKey", event)

  /** Puts the callback on the current activity's window, once; on the UI thread. */
  private fun attach() {
    val activity: Activity = appContext.currentActivity ?: return
    activity.runOnUiThread {
      val window = activity.window
      if (!listening || installed?.first === window) return@runOnUiThread
      detach()
      val mine = KeysWindowCallback(window.callback, ::emit)
      window.callback = mine
      installed = window to mine
    }
  }

  /** Gives the window its own callback back (unless something wrapped ours since: then ours stays, passing everything on). */
  private fun detach() {
    val (window, mine) = installed ?: return
    installed = null
    if (window.callback === mine) window.callback = mine.wrapped
  }

  override fun definition() = ModuleDefinition {
    Name("AiwbKeys")

    Events("onKey")

    OnStartObserving {
      listening = true
      attach()
    }

    OnStopObserving {
      listening = false
      appContext.currentActivity?.runOnUiThread { detach() } ?: detach()
    }

    // A new activity (the app comes back after the system ended the first) has a window without our callback.
    OnActivityEntersForeground { if (listening) attach() }

    OnActivityDestroys { installed = null }
  }
}

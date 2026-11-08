// The sticky note (goal 3.2, risk 8.3; decisions U3 and window lane): a ShapeUtil of our own, type `aiwb-sticky`, not
// tldraw's `note`. A square box in one of our 16 colours, rich text that shrinks to fit (fit.ts) so the note keeps its size,
// refitted on every change of the text, the size, the font or the fixed font size. The fitted size is stored (`fitted`), so
// every peer draws what the peer that made the change measured, and an agent reads it back (`shownSize`).
//
// The fit runs in onBeforeCreate / onBeforeUpdate (the hooks tldraw's own note uses for its growY), through
// `editor.textMeasure`: the board host replaces that measure with its skia-canvas one, so the same code fits there. These hooks
// run only from `editor.createShapes/updateShapes`, not for records put into the store directly: agent ops go through the
// editor API.
//
// Lifted from the spike (`spikes/tl-ui/src/sticky/`); the props are `sticky-props.ts`'s, the colours `palette.ts`'s.
import {
  BaseBoxShapeTool,
  Box,
  DefaultFontFamilies,
  Group2d,
  Rectangle2d,
  RichTextLabel,
  RichTextSVG,
  ShapeUtil,
  getFontsFromRichText,
  isEqual,
  renderHtmlFromRichTextForMeasurement,
  renderPlaintextFromRichText,
  resizeBox,
  toRichText,
  type Editor,
  type TLDefaultFontStyle,
  type TLFontFace,
  type TLResizeInfo,
  type TLRichText,
} from "tldraw";
import { DEFAULT_STICKY, STICKY_SIZE, STICKY_TYPE } from "../palette.ts";
import { stickyHex, stickyTextColor } from "../styles.ts";
import { autoRange, fitFontSize, type MeasureAt } from "./fit.ts";
import { stickyShapeMigrations, stickyShapeProps, type StickyProps, type StickyShape } from "./sticky-props.ts";

export { STICKY_SIZE, STICKY_TYPE };
export type { StickyProps, StickyShape };
export const STICKY_PADDING = 16;
export const STICKY_LINE_HEIGHT = 1.35;
/** The id of the sticky tool (the main toolbar's "Sticky"). */
export const STICKY_TOOL = "sticky";

const H_ALIGN = { start: "start", middle: "center", end: "end", "start-legacy": "start", "middle-legacy": "center", "end-legacy": "end" } as const;

export function stickyFontFamily(editor: Editor, font: TLDefaultFontStyle): string {
  return editor.getCurrentTheme().fonts[font]?.fontFamily ?? (DefaultFontFamilies as Record<string, string>)[font] ?? font;
}

/** The text measure of the fit, on the editor's own measure (DOM in a window, skia-canvas in the board host). */
export function stickyMeasure(editor: Editor, shape: StickyShape): MeasureAt {
  const html = renderHtmlFromRichTextForMeasurement(editor, shape.props.richText);
  const fontFamily = stickyFontFamily(editor, shape.props.font);
  return (fontSize, maxWidth) =>
    editor.textMeasure.measureHtml(html, {
      fontStyle: "normal",
      fontWeight: "normal",
      fontFamily,
      fontSize,
      lineHeight: STICKY_LINE_HEIGHT,
      // one px narrower than the label draws, so a line that just fits when measured also fits when drawn
      maxWidth: maxWidth - 1,
      padding: "0px",
      disableOverflowWrapBreaking: true,
      measureScrollWidth: true,
    });
}

function isEmpty(editor: Editor, richText: TLRichText) {
  return renderPlaintextFromRichText(editor, richText).trim() === "";
}

export class StickyShapeUtil extends ShapeUtil<StickyShape> {
  static override type = STICKY_TYPE;
  static override props = stickyShapeProps;
  static override migrations = stickyShapeMigrations;

  override getDefaultProps(): StickyProps {
    return {
      w: STICKY_SIZE,
      h: STICKY_SIZE,
      color: DEFAULT_STICKY,
      font: "sans",
      align: "middle",
      verticalAlign: "middle",
      richText: toRichText(""),
      fontSize: 0,
      fitted: autoRange(STICKY_SIZE).max,
    };
  }

  override canEdit() { return true; }
  override canResize() { return true; }
  override isAspectRatioLocked() { return true; }
  override hideSelectionBoundsFg() { return false; }

  override getGeometry(shape: StickyShape) {
    const { w, h } = shape.props;
    return new Group2d({
      children: [
        new Rectangle2d({ width: w, height: h, isFilled: true }),
        // the label's area, so a double-click on the text edits it (tldraw finds labels by `isLabel`)
        new Rectangle2d({ width: w, height: h, isFilled: true, isLabel: true, excludeFromShapeBounds: true }),
      ],
    });
  }

  override getText(shape: StickyShape) {
    return renderPlaintextFromRichText(this.editor, shape.props.richText);
  }

  override getFontFaces(shape: StickyShape): TLFontFace[] {
    if (isEmpty(this.editor, shape.props.richText)) return [];
    return getFontsFromRichText(this.editor, shape.props.richText, { family: `tldraw_${shape.props.font}`, weight: "normal", style: "normal" });
  }

  override onResize(shape: StickyShape, info: TLResizeInfo<StickyShape>) {
    return resizeBox(shape, info);
  }

  /** The fit of `shape` as it is: its `fitted`, computed. */
  fit(shape: StickyShape) {
    const { w, h, fontSize, richText } = shape.props;
    return fitFontSize({ w, h, padding: STICKY_PADDING, fixed: fontSize, empty: isEmpty(this.editor, richText) }, stickyMeasure(this.editor, shape));
  }

  private withFit(shape: StickyShape): StickyShape | undefined {
    const { fontSize } = this.fit(shape);
    if (fontSize === shape.props.fitted) return undefined;
    return { ...shape, props: { ...shape.props, fitted: fontSize } };
  }

  override onBeforeCreate(next: StickyShape) {
    return this.withFit(next);
  }

  override onBeforeUpdate(prev: StickyShape, next: StickyShape) {
    const a = prev.props;
    const b = next.props;
    if (a.w === b.w && a.h === b.h && a.font === b.font && a.fontSize === b.fontSize && isEqual(a.richText, b.richText)) return;
    return this.withFit(next);
  }

  override component(shape: StickyShape) {
    const { id, type, props } = shape;
    const isSelected = shape.id === this.editor.getOnlySelectedShapeId();
    const isEditing = this.editor.getEditingShapeId() === shape.id;
    const empty = isEmpty(this.editor, props.richText);
    return (
      <div
        id={id}
        className="aiwb-sticky"
        style={{ width: props.w, height: props.h, backgroundColor: stickyHex(props.color), boxShadow: "0 1px 3px rgba(0,0,0,.18)", overflow: "hidden" }}
      >
        {(isSelected || isEditing || !empty) && (
          <RichTextLabel
            shapeId={id}
            type={type}
            fontFamily={stickyFontFamily(this.editor, props.font)}
            fontSize={props.fitted}
            lineHeight={STICKY_LINE_HEIGHT}
            textAlign={H_ALIGN[props.align]}
            verticalAlign={props.verticalAlign}
            richText={props.richText}
            isSelected={isSelected}
            labelColor={stickyTextColor(props.color)}
            wrap
            padding={STICKY_PADDING}
            showTextOutline={false}
          />
        )}
      </div>
    );
  }

  override getIndicatorPath(shape: StickyShape) {
    const p = new Path2D();
    p.rect(0, 0, shape.props.w, shape.props.h);
    return p;
  }

  override toSvg(shape: StickyShape) {
    const { props } = shape;
    const bounds = new Box(0, 0, props.w, props.h);
    return (
      <>
        <rect width={props.w} height={props.h} fill={stickyHex(props.color)} />
        <RichTextSVG
          bounds={bounds}
          richText={props.richText}
          fontSize={props.fitted}
          fontFamily={stickyFontFamily(this.editor, props.font)}
          lineHeight={STICKY_LINE_HEIGHT}
          textAlign={H_ALIGN[props.align]}
          verticalAlign={props.verticalAlign}
          labelColor={stickyTextColor(props.color)}
          padding={STICKY_PADDING}
          showTextOutline={false}
          wrap
        />
      </>
    );
  }
}

/** The sticky tool: tldraw's box tool (a click places a note at its default size, a drag sizes it, then back to select). */
export class StickyTool extends BaseBoxShapeTool {
  static override id = STICKY_TOOL;
  static override initial = "idle";
  override shapeType: typeof STICKY_TYPE = STICKY_TYPE;
}

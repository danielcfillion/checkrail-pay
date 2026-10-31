/**
 * AG Studio theme parameters for "Your first weeks". Every colour, font and shadow is one of the app's own CSS tokens
 * (src/app/globals.css) passed through as var(), so Studio follows the page: light, dark from prefers-color-scheme, or
 * a forced data-theme, with no second palette to keep in sync. Sizes are plain numbers.
 *
 * Cards: Studio has no widget shadow parameter, so widgets get the app's near-invisible card edge as their border
 * and the soft card shadow comes from studio.css (scoped to this screen). Radius 16 matches .panel.
 *
 * Chart palette: cobalt (--action) first, then navy ink, then neutrals. Status colours (green, amber, red) are not in
 * the palette; widgets use them only where they mean status.
 *
 * Pure (no Studio runtime import) so it is tested in node; onboardingTheme.ts applies it to studioTheme.
 */

export const token = (name: string) => `var(--${name})`;

const line = (name: string, width = 1) => ({ style: "solid" as const, width, color: token(name) });

/** The categorical chart palette, in order. */
export const CHART_PALETTE = [token("action"), token("ink"), token("ink-soft"), token("rail-bank"), token("rule-strong")] as const;

const palette = Object.fromEntries(
  CHART_PALETTE.flatMap((color, i) => [
    [`chartPaletteFills${i + 1}Color`, color],
    [`chartPaletteStrokes${i + 1}Color`, color],
  ]),
);

const FONT = token("font-geist-sans");

export const onboardingThemeParams = {
  // Shared by Studio's UI, grids and charts.
  browserColorScheme: "inherit",
  fontFamily: FONT,
  fontSize: 14,
  textColor: token("ink"),
  foregroundColor: token("ink"),
  subtleTextColor: token("ink-soft"),
  backgroundColor: token("sheet"),
  borderColor: token("rule"),
  accentColor: token("action"),
  invalidColor: token("blocked"),
  iconColor: token("ink-soft"),
  rowHoverColor: token("neutral-soft"),
  menuBackgroundColor: token("sheet"),
  menuTextColor: token("ink"),
  menuBorder: line("rule"),
  menuSeparatorColor: token("rule"),
  menuShadow: token("card-shadow"),
  popupShadow: token("card-shadow"),
  dialogShadow: token("card-shadow"),
  dropdownShadow: token("card-shadow"),
  tooltipBackgroundColor: token("hero"),
  tooltipTextColor: token("hero-ink"),
  tooltipBorder: false,
  focusShadow: { radius: 0, spread: 2, color: token("focus") },

  // No frame: the canvas is the page's own paper, and the cards lift off it.
  studioWrapperBorder: false,
  studioWrapperBorderRadius: 0,
  studioWrapperSpacing: 0,
  studioWrapperBackgroundColor: token("paper"),
  studioCanvasBorder: false,
  studioCanvasBorderRadius: 0,
  studioCanvasShadow: false,
  studioCanvasBackgroundColor: token("paper"),
  studioCanvasGridLineColor: token("rule"),
  studioCanvasPadding: 0,
  studioCanvasRowHeight: 16,
  studioCanvasFontFamily: FONT,
  studioCanvasDragPreviewBackgroundColor: token("action-soft"),
  studioCanvasDragPreviewShadow: token("card-shadow"),

  // Widgets are the app's .panel cards: sheet, 16px radius, the near-invisible edge (shadow in studio.css).
  studioWidgetBackgroundColor: token("sheet"),
  studioWidgetBorder: line("card-edge"),
  studioWidgetBorderRadius: 16,
  // Studio's "widget padding" is the inset around each card: 10 each side makes a 20px gutter between cards.
  studioWidgetPadding: 10,
  studioWidgetTitleFontFamily: FONT,
  studioWidgetTitleFontSize: 15,
  studioWidgetTitleFontWeight: 600,
  studioWidgetTitleTextColor: token("ink"),
  studioWidgetSubtitleFontFamily: FONT,
  studioWidgetSubtitleFontSize: 13,
  studioWidgetSubtitleTextColor: token("ink-soft"),
  studioWidgetCaptionFontFamily: FONT,
  studioWidgetCaptionFontSize: 12,
  studioWidgetCaptionTextColor: token("ink-soft"),
  studioWidgetResizeBorderColor: token("action"),
  studioWidgetToolbarBackgroundColor: token("sheet"),
  studioWidgetToolbarBorder: line("rule"),
  studioWidgetToolbarShadow: token("card-shadow"),
  studioWidgetToolbarButtonColor: token("ink"),
  studioWidgetToolbarButtonHoverBackgroundColor: token("neutral-soft"),
  studioWidgetSelectionItemBackgroundColor: token("sheet"),
  studioWidgetSelectionItemBorder: line("rule"),
  studioWidgetLoadingOverlayBackgroundColor: token("sheet"),
  studioWidgetNoDataOverlayBackgroundColor: token("sheet"),
  studioValueWidgetFontSize: 30,

  // Edit-mode and assistant panels read as part of the page: sheet cards with the same edge.
  studioPanelContainerBackgroundColor: token("sheet"),
  studioPanelContainerBorder: line("card-edge"),
  studioPanelContainerBorderRadius: 16,
  studioPanelDividerColor: token("rule"),
  studioPanelDividerActiveColor: token("action"),
  studioPanelSectionBorderColor: token("rule"),
  studioPanelGroupBackgroundColor: token("sheet"),
  studioPanelGroupTitleBarTextColor: token("ink"),
  studioPanelHeaderFontFamily: FONT,
  studioPanelHeaderFontSize: 15,
  studioPanelHeaderFontWeight: 600,
  studioPanelChevronButtonHoverBackgroundColor: token("neutral-soft"),
  studioPanelChevronButtonHoverColor: token("ink"),
  studioFormLabelColor: token("ink-soft"),
  studioToggleButtonActiveBackgroundColor: token("action-soft"),
  studioToggleButtonActiveBorderColor: token("action"),
  studioToggleButtonActiveColor: token("action"),
  studioAiPanelWidth: 340,
  studioAiPanelButtonHoverBackgroundColor: token("neutral-soft"),
  studioAiPanelRichTextAccentBackgroundColor: token("action-soft"),
  studioAiPanelInputMessageBackgroundColor: token("neutral-soft"),
  studioDragAndDropImageBackgroundColor: token("sheet"),
  studioDragAndDropImageTextColor: token("ink"),
  studioDragAndDropImageIconColor: token("ink-soft"),
  studioDragAndDropImageBorder: line("rule"),
  studioDragAndDropImageShadow: token("card-shadow"),

  // Grid widgets: the app's ledger table. Quiet headers, hairlines, no zebra.
  gridFontFamily: FONT,
  gridFontSize: 14,
  gridCellTextColor: token("ink"),
  gridHeaderBackgroundColor: token("sheet"),
  gridDataBackgroundColor: token("sheet"),
  gridOddRowBackgroundColor: token("sheet"),
  gridHeaderTextColor: token("ink-soft"),
  gridHeaderFontWeight: 500,
  gridHeaderFontSize: 12,
  gridRowHeight: 40,
  gridRowBorder: line("rule"),
  gridHeaderRowBorder: line("rule"),
  gridPinnedRowBorder: line("rule-strong"),
  gridRowHoverColor: token("neutral-soft"),
  gridIconColor: token("ink-soft"),
  gridAccentColor: token("action"),
  gridWrapperBorder: false,

  // Charts.
  chartFontFamily: FONT,
  chartFontSize: 12,
  chartTextColor: token("ink"),
  chartSubtleTextColor: token("ink-soft"),
  chartAxisLineColor: token("rule-strong"),
  chartGridLineColor: token("rule"),
  chartAccentColor: token("action"),
  chartTooltipBackgroundColor: token("hero"),
  chartTooltipTextColor: token("hero-ink"),
  chartTooltipBorder: false,
  chartTooltipBorderRadius: 10,
  ...palette,
} as const;

/** CSS keywords a parameter may hold besides a token. */
export const THEME_KEYWORDS = new Set(["inherit", "solid"]);

import { themeQuartz } from "ag-grid-community";

/**
 * The app's ledger table, drawn by AG Grid. Every colour is one of the app's own CSS tokens (globals.css), passed
 * through as a var() so the grid changes with the page: light, dark from prefers-color-scheme, or a forced
 * data-theme. There is no second dark palette to keep in sync. Archivo comes from the page (font: inherit);
 * tabular figures, the 88% header width and the pinned totals live in grid.css.
 */
export const checkrailGridTheme = themeQuartz.withParams({
  browserColorScheme: "inherit",
  fontFamily: "inherit",
  headerFontFamily: "inherit",
  fontSize: 14,
  dataFontSize: 14,
  headerFontSize: 12,
  headerFontWeight: 500,

  backgroundColor: "var(--sheet)",
  foregroundColor: "var(--ink)",
  textColor: "var(--ink)",
  subtleTextColor: "var(--ink-soft)",
  headerTextColor: "var(--ink-soft)",
  chromeBackgroundColor: "var(--sheet)",
  headerBackgroundColor: "var(--sheet)",
  accentColor: "var(--focus)",
  invalidColor: "var(--blocked)",

  // Hairlines, no shadows, no zebra: the same rules as table.ledger.
  borderColor: "var(--rule)",
  wrapperBorder: false,
  wrapperBorderRadius: 0,
  borderRadius: 4,
  rowBorder: { style: "solid", width: 1, color: "var(--rule)" },
  headerRowBorder: { style: "solid", width: 1, color: "var(--rule)" },
  columnBorder: false,
  headerColumnBorder: false,
  oddRowBackgroundColor: "var(--sheet)",
  rowHoverColor: "color-mix(in srgb, var(--paper) 60%, var(--sheet))",
  selectedRowBackgroundColor: "color-mix(in srgb, var(--focus) 9%, var(--sheet))",
  pinnedRowBorder: { style: "solid", width: 1, color: "var(--rule-strong)" },
  pinnedRowBackgroundColor: "color-mix(in srgb, var(--paper) 55%, var(--sheet))",
  pinnedRowFontWeight: 600,

  // Same density as the hand-written tables: 10px by 12px cells on a 20px line.
  rowHeight: 40,
  // Short autoHeight grids (a few payable requests) end at their last row instead of a 150px empty body.
  autoHeightMinBodyHeight: 40,
  headerHeight: 36,
  cellHorizontalPadding: 12,
  spacing: 6,
  iconSize: 14,
  iconColor: "var(--ink-soft)",

  // Keyboard focus is the app's focus blue, never a shadow.
  focusShadow: { radius: 0, spread: 2, color: "var(--focus)" },
  rangeSelectionBorderColor: "var(--focus)",
  inputFocusBorder: { style: "solid", width: 1, color: "var(--focus)" },
  inputBorder: { style: "solid", width: 1, color: "var(--rule-strong)" },
  inputBackgroundColor: "var(--sheet)",

  checkboxBorderRadius: 3,
  checkboxUncheckedBackgroundColor: "var(--sheet)",
  checkboxUncheckedBorderColor: "var(--rule-strong)",
  checkboxCheckedBackgroundColor: "var(--primary)",
  checkboxCheckedBorderColor: "var(--primary)",
  checkboxCheckedShapeColor: "var(--primary-ink)",
  checkboxIndeterminateBackgroundColor: "var(--primary)",
  checkboxIndeterminateBorderColor: "var(--primary)",
  checkboxIndeterminateShapeColor: "var(--primary-ink)",

  menuBackgroundColor: "var(--sheet)",
  menuTextColor: "var(--ink)",
  menuBorder: { style: "solid", width: 1, color: "var(--rule-strong)" },
  popupShadow: "none",
  menuShadow: "none",
  cardShadow: "none",
  tooltipBackgroundColor: "var(--ink)",
  tooltipTextColor: "var(--sheet)",
});

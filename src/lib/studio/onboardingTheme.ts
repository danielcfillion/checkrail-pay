import { studioTheme } from "ag-studio";
import { onboardingThemeParams } from "./onboardingThemeParams";

/** Studio's theme for "Your first weeks": studioTheme with every value pointing at the app's tokens. */
export const onboardingStudioTheme = studioTheme.withParams(onboardingThemeParams as Parameters<typeof studioTheme.withParams>[0]);

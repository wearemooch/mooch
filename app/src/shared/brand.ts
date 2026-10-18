// The product's names and identifiers (brand book: D:\brud\mooch\assets). Also kept in sync by hand:
// package.json (name, productName, build.appId, nsis.shortcutName), src/renderer/index.html <title>,
// build/icon.ico (scripts/make-icon.cjs) and the runtime folder name in build/installer.nsh.

/** The app. Always lowercase, like the wordmark. */
export const APP_NAME = 'mooch';
/** The coding agent inside the app; it introduces itself by this name. */
export const AGENT_NAME = 'Penny';
export const TAGLINE = 'The coding agent that runs on other people’s free tiers.';
/** Windows AppUserModelID: groups taskbar entries and notifications. Must match package.json build.appId. */
export const APP_ID = 'app.mooch.desktop';
/** Folder name under %APPDATA% for settings, restore points and the model gateway's data. */
export const DATA_FOLDER = 'mooch';
/** The folder this app used before the rename; settings and provider keys are carried over once. */
export const PREVIOUS_DATA_FOLDER = 'free-code';

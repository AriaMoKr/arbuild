// When the app's source files last changed, from ./__version.json (served by the dev
// server, written into production builds; see scripts/vite-plugins.mjs). Shown on the
// page and in AR so you can tell whether the headset is running the latest code.

/** Fetches the version once. Resolves to { changed, file, text } or null if it isn't available. */
export async function fetchVersion() {
  try {
    const response = await fetch('./__version.json', { cache: 'no-store' });
    if (!response.ok) return null;
    const { changed, file } = await response.json();
    return changed ? { changed, file, text: formatVersion(changed) } : null;
  } catch {
    return null;
  }
}

/** "Updated 4 Oct 2026, 09:12:45" in the viewer's locale, with seconds to tell quick edits apart. */
export function formatVersion(changed, locale = undefined) {
  return `Updated ${new Date(changed).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'medium' })}`;
}

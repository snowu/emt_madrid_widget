/** Walking directions in the Google Maps app, from a tap inside the page.
 *
 * A notification can only open a browser window, and neither Android nor iOS
 * hands a window opened that way to another app. So a notification tap opens
 * Hubward, and Hubward launches Maps: a navigation from inside the page is
 * what both systems route to the app.
 *   Android: an intent: URL naming the Maps package, falling back to the web
 *            page if Maps is not installed.
 *   iOS:     Google Maps' own comgooglemaps:// scheme. Nothing falls back if
 *            the app is missing, which is why the web link is always offered.
 * Coordinates are GeoJSON [lon, lat]; every URL below wants lat,lon. */
export function mapsDirections(coordinates, userAgent = "", touchPoints = 0) {
  const [lon, lat] = Array.isArray(coordinates) ? coordinates.map(Number) : [];
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const web = new URL("https://www.google.com/maps/dir/");
  web.searchParams.set("api", "1");
  web.searchParams.set("destination", `${lat},${lon}`);
  web.searchParams.set("travelmode", "walking");
  // iPadOS reports itself as a Mac; a touch screen gives it away.
  const ios = /iPhone|iPad|iPod/i.test(userAgent) || (/Macintosh/i.test(userAgent) && touchPoints > 1);
  let app = null;
  if (/Android/i.test(userAgent)) {
    app = `intent://maps.google.com/maps?daddr=${lat},${lon}&dirflg=w#Intent;scheme=https;` +
      `package=com.google.android.apps.maps;S.browser_fallback_url=${encodeURIComponent(web.href)};end`;
  } else if (ios) {
    app = `comgooglemaps://?daddr=${lat},${lon}&directionsmode=walking`;
  }
  return { app, web: web.href };
}

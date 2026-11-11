// Node presentation tests don't load image bytes or construct a WebGL renderer.
// Retain the URL value that Vite would supply; all non-assets use the real loader.
export async function load(url, context, nextLoad) {
  if (url.startsWith("file:") && /\.(jpg|jpeg|png|webp|svg|glb)(\?url)?$/.test(url)) {
    return { format: "module", source: `export default ${JSON.stringify(url)};`, shortCircuit: true };
  }
  return nextLoad(url, context);
}

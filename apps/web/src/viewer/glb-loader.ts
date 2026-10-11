// Parse GLB bytes (already fetched from our own origin by the vehicle-models service) into a three Group.
// GLTFLoader decodes embedded images with ImageBitmapLoader, which fetch()es a blob: URL; our CSP has
// connect-src 'self' (no blob:), so a plugin swaps in TextureLoader, which uses an <img> (img-src blob: is allowed).
import { TextureLoader, type Group } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { disposeModel } from "./glb-model";

let loader: GLTFLoader | null = null;

function gltfLoader(): GLTFLoader {
  if (loader) return loader;
  loader = new GLTFLoader();
  loader.register((parser) => {
    (parser as unknown as { textureLoader: TextureLoader }).textureLoader = new TextureLoader(parser.options.manager);
    return { name: "csd_img_textures" };
  });
  return loader;
}

/** The model's scene graph. Rejects on a file that isn't a usable glTF; aborts quietly when `signal` fires first. */
export function parseGlb(bytes: ArrayBuffer, signal?: AbortSignal): Promise<Group> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException("aborted", "AbortError")); return; }
    // GLTFLoader tests `instanceof ArrayBuffer`; bytes from another realm (a worker, a test runner) are copied into this one.
    const data = bytes instanceof ArrayBuffer ? bytes : new Uint8Array(new Uint8Array(bytes)).buffer;
    gltfLoader().parse(data, "", (gltf) => {
      // Given up while parsing (the vehicle changed, the viewer closed): free what was built.
      if (signal?.aborted) { disposeModel(gltf.scene); reject(new DOMException("aborted", "AbortError")); return; }
      resolve(gltf.scene);
    }, (e) => reject(e instanceof Error ? e : new Error(String(e))));
  });
}

import * as THREE from "three";

export type CityObjectView<T extends THREE.Object3D> = Readonly<{
  root: T;
  resolve<R extends THREE.Object3D>(object: R): R;
}>;

export function cloneCityObjectView<T extends THREE.Object3D>(source: T): CityObjectView<T> {
  const root = source.clone(true) as T;
  const objects = new Map<THREE.Object3D, THREE.Object3D>();
  const index = (original: THREE.Object3D, cloned: THREE.Object3D) => {
    objects.set(original, cloned);
    for (let child = 0; child < original.children.length; child++) index(original.children[child], cloned.children[child]);
  };
  index(source, root);
  return { root, resolve<R extends THREE.Object3D>(object: R): R {
    const existing = objects.get(object);
    if (existing) return existing as R;
    const cloned = object.clone(true) as R;
    index(object, cloned);
    root.add(cloned);
    return cloned;
  } };
}

import * as THREE from "three";
import { FACADE_SKY_GLSL, type FacadeUniforms } from "./facadeMaterial";
import { selfLitMaterial } from "./shared";
/** Keep walls/mullions diffuse; only explicitly marked glass receives sky reflection. */
export function civicGlassMaterial(environment?:FacadeUniforms):THREE.MeshLambertMaterial {
  const material=selfLitMaterial(0.18),baseCompile=material.onBeforeCompile;
  const uniforms=environment??{
    uEnv:{value:null},uEnvStrength:{value:0},uGradeTop:{value:new THREE.Color("#adcddd")},
    uGradeHorizon:{value:new THREE.Color("#d4e0e4")},uGradeAmount:{value:0},uSkyYaw:{value:0},
  };
  material.onBeforeCompile=(shader,renderer)=>{
    baseCompile.call(material,shader,renderer);
    for(const name of ["uEnv","uEnvStrength","uGradeTop","uGradeHorizon","uGradeAmount","uSkyYaw"] as const)shader.uniforms[name]=uniforms[name];
    shader.vertexShader=shader.vertexShader
      .replace("#include <common>","#include <common>\nattribute float aCivicGlass; varying float vCivicGlass; varying vec3 vCivicWorld; varying vec3 vCivicNormal;")
      .replace("#include <project_vertex>",`#include <project_vertex>
vCivicGlass=aCivicGlass;
vCivicWorld=(modelMatrix*instanceMatrix*vec4(transformed,1.0)).xyz;
vCivicNormal=normalize(mat3(modelMatrix)*mat3(instanceMatrix)*objectNormal);`);
    shader.fragmentShader=shader.fragmentShader
      .replace("#include <common>",`#include <common>
varying float vCivicGlass; varying vec3 vCivicWorld; varying vec3 vCivicNormal;
uniform sampler2D uEnv; uniform float uEnvStrength; uniform vec3 uGradeTop; uniform vec3 uGradeHorizon; uniform float uGradeAmount; uniform float uSkyYaw;
${FACADE_SKY_GLSL}`)
      .replace("#include <opaque_fragment>",`if(vCivicGlass>0.5){
  vec3 viewDir=normalize(vCivicWorld-cameraPosition),n=normalize(vCivicNormal);
  vec3 reflected=reflect(viewDir,n);
  float fresnel=0.06+0.94*pow(1.0-max(dot(-viewDir,n),0.0),4.0);
  vec3 sky=mix(vec3(0.22,0.34,0.42),vec3(0.65,0.80,0.90),max(reflected.y,0.0));
  if(uEnvStrength>0.0)sky=facadeSky(reflected);
  outgoingLight=mix(outgoingLight,sky*mix(0.68,1.0,smoothstep(-0.15,0.25,reflected.y)),0.35+0.5*fresnel);
}
#include <opaque_fragment>`);
  };
  material.customProgramCacheKey=()=>"city-civic-glass-v1";
  return material;
}

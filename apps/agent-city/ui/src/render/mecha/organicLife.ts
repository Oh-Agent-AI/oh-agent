import * as THREE from "three";

/** Deterministic tissue pulses, purely visual and independent of game state. */
export function createOrganicLife(kind: "spore_leaper" | "many_core") {
  const centers = kind === "spore_leaper" ? [[0,0,0,2.3],[-3,.7,.2,1.3],[2.9,.6,.4,1.2],[-1.65,2.5,-.2,1.0],[1.25,2.9,-.35,1.0]] : [[-2.8,0,0,1.5],[0,1.35,-.35,1.65],[2.8,0,0,1.5],[0,-2.15,.2,1.1]];
  const count = 1600, positions = new Float32Array(count*3), parameters = new Float32Array(count*2);
  for (let i=0;i<count;i++) {
    const n=i%centers.length, j=Math.floor(i/centers.length), per=Math.ceil(count/centers.length);
    const y=1-2*(j+.5)/per, angle=j*2.399963229728653, c=centers[n]!, r=c[3]!;
    positions.set([c[0]!+r*Math.sqrt(1-y*y)*Math.cos(angle),c[1]!+r*y,c[2]!+r*Math.sqrt(1-y*y)*Math.sin(angle)],i*3);
    parameters.set([n,angle],i*2);
  }
  const geometry=new THREE.BufferGeometry(); geometry.setAttribute("position",new THREE.BufferAttribute(positions,3)); geometry.setAttribute("lifeData",new THREE.BufferAttribute(parameters,2)); geometry.boundingSphere=new THREE.Sphere(new THREE.Vector3(),7);
  const material=new THREE.ShaderMaterial({uniforms:{phase:{value:0},tint:{value:new THREE.Color(kind === "spore_leaper" ? 0x8fffc1 : 0xff9aa9)},organic:{value:kind === "spore_leaper" ? 1 : 0}},vertexShader:`attribute vec2 lifeData; uniform float phase; uniform float organic; varying float glow; varying float fade;
    void main(){float wave=sin(phase*(1.0+lifeData.x*.08)+lifeData.x*1.4+lifeData.y*organic*2.0); vec3 p=position*(1.0+.025*wave); glow=.4+.6*pow(.5+.5*wave,3.0); vec4 view=modelViewMatrix*vec4(p,1.0); fade=projectionMatrix[2][3]==0.0?1.0:clamp(24.0/max(1.0,-view.z),.12,1.0); gl_Position=projectionMatrix*view; gl_PointSize=max(1.0,4.0*fade);}`,fragmentShader:`uniform vec3 tint; varying float glow; varying float fade; void main(){float r=length(gl_PointCoord-.5); if(r>.5) discard; gl_FragColor=vec4(tint,glow*(1.0-r*2.0)*fade);}`,transparent:true,depthWrite:false,blending:THREE.AdditiveBlending});
  const root=new THREE.Points(geometry,material); root.name=`organic-life-${kind}`; root.raycast=()=>{};
  return {root,update(elapsed:number,reducedMotion:boolean){if (!reducedMotion) material.uniforms.phase!.value=elapsed;},dispose(){root.removeFromParent();geometry.dispose();material.dispose();}};
}

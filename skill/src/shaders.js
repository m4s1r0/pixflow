// Shaders GLSL do motor pixflow-motion — v2.
// v2: o offset da câmera agora TRANSLADA a moldura de verdade (antes só alimentava o
// parallax diferencial ≈0.1×, por isso "pan" mal saía do lugar). Pipeline:
//   rotação (roll/dutch) → zoom → translação global → parallax 2.5D por profundidade
//   (translação E zoom geram displacement diferencial — dolly com sensação de profundidade)
//   → blur direcional (whip pan / crash zoom) → pilha de efeitos.

export const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

export const FRAG = `
precision highp float;
varying vec2 vUv;

uniform sampler2D uImage;
uniform sampler2D uDepth;
uniform vec2  uResolution;
uniform float uTime;

// câmera / parallax
uniform vec2  uOffset;     // translação REAL da moldura (fração do quadro)
uniform float uZoom;       // >1 = aproxima (push-in)
uniform float uRotate;     // roll/dutch em radianos
uniform float uParallax;   // força do parallax 2.5D
uniform float uBlur;       // blur direcional (whip pan / crash zoom), raio em UV

// efeitos (0 = desligado)
uniform float uGrain;
uniform float uVignette;
uniform float uChroma;     // aberração cromática
uniform float uExposure;
uniform float uSaturation;
uniform vec3  uLift;       // grade: sombras
uniform vec3  uGain;       // grade: ganho geral
uniform float uBloom;      // glow suave nas altas luzes

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }

vec3 sampleScene(vec2 uv) {
  // parallax 2.5D: depth ~1 = perto, ~0 = longe.
  // anti-fantasma em 4 camadas:
  //  (a) depth SUAVIZADO (9 taps, cruz+diagonais) — transição perto→longe gradual não rasga o contorno;
  //  (b) supressão CIENTE DE BORDA, raio PROPORCIONAL ao parallax — com uParallax alto o
  //      displacement viaja mais longe que o raio fixo de 3px enxergava, então uma transição
  //      larga e suave (ex.: folhagem fora de foco/bokeh) não era detectada como "borda" e
  //      o contorno ondulava/duplicava ("fantasma"). O raio agora cresce com uParallax para
  //      sempre olhar pelo menos até onde o próprio displacement vai alcançar;
  //  (c) supressão de ESTRUTURA FINA — galho, folhagem, cabelo: o depth (mesmo refinado por
  //      guided filter) oscila muito em pouco espaço porque é silhueta fina sem informação
  //      do que está atrás. Não dá pra "ocluir certo" uma estrutura de 1-2px com uma única
  //      imagem — então, em vez de deslocar e esgarçar o contorno, detecta a ALTA VARIÂNCIA
  //      LOCAL (raio fixo, pequeno) e desliga o parallax ali — estrutura fina fica estática;
  //  (d) teto de segurança no displacement — rede de proteção final para depth ruidoso.
  // medido em fotos reais: a transição perto->longe numa borda com fora-de-foco/bokeh
  // se espalha por ~20-30px (não 3-6px) — o raio precisa alcançar pelo menos isso pra
  // enxergar a queda inteira em vez de só uma fatia quase plana dela.
  float lookAhead = clamp(uParallax * 40.0, 1.0, 20.0);
  vec2 px = lookAhead * 3.0 / uResolution;
  float dC  = texture2D(uDepth, clamp(uv, 0.0, 1.0)).r;
  float dR  = texture2D(uDepth, clamp(uv + vec2(px.x, 0.0), 0.0, 1.0)).r;
  float dL  = texture2D(uDepth, clamp(uv - vec2(px.x, 0.0), 0.0, 1.0)).r;
  float dU  = texture2D(uDepth, clamp(uv + vec2(0.0, px.y), 0.0, 1.0)).r;
  float dD  = texture2D(uDepth, clamp(uv - vec2(0.0, px.y), 0.0, 1.0)).r;
  float dTR = texture2D(uDepth, clamp(uv + vec2(px.x, px.y), 0.0, 1.0)).r;
  float dTL = texture2D(uDepth, clamp(uv + vec2(-px.x, px.y), 0.0, 1.0)).r;
  float dBR = texture2D(uDepth, clamp(uv + vec2(px.x, -px.y), 0.0, 1.0)).r;
  float dBL = texture2D(uDepth, clamp(uv + vec2(-px.x, -px.y), 0.0, 1.0)).r;
  float d = (dC * 4.0 + (dR + dL + dU + dD) * 1.5 + dTR + dTL + dBR + dBL) / 14.0;
  // borda axial (translação) + borda diagonal (cobre contornos fora dos eixos x/y)
  float edgeAxis = length(vec2(dR - dL, dU - dD));
  float edgeDiag = length(vec2(dTR - dBL, dTL - dBR));
  float edge = clamp(max(edgeAxis, edgeDiag) * 7.0, 0.0, 1.0);

  // variância local em raio FIXO e pequeno (independe do parallax) — mede "quão picotado"
  // o depth está logo ao redor do pixel. Edge (acima) pergunta "há UMA borda daqui até o
  // alcance do displacement?"; variância pergunta "isso aqui é silhueta fina oscilando?".
  vec2 fpx = 2.0 / uResolution;
  float fR = texture2D(uDepth, clamp(uv + vec2(fpx.x, 0.0), 0.0, 1.0)).r;
  float fL = texture2D(uDepth, clamp(uv - vec2(fpx.x, 0.0), 0.0, 1.0)).r;
  float fU = texture2D(uDepth, clamp(uv + vec2(0.0, fpx.y), 0.0, 1.0)).r;
  float fD = texture2D(uDepth, clamp(uv - vec2(0.0, fpx.y), 0.0, 1.0)).r;
  float fMean = (dC + fR + fL + fU + fD) / 5.0;
  float variance = ((dC - fMean) * (dC - fMean) + (fR - fMean) * (fR - fMean)
                   + (fL - fMean) * (fL - fMean) + (fU - fMean) * (fU - fMean)
                   + (fD - fMean) * (fD - fMean)) / 5.0;
  float filigree = clamp(variance * 55.0, 0.0, 1.0);

  // mesma ideia, mas no raio LARGO (lookAhead): pega oscilação que só aparece numa janela
  // maior que a da silhueta fina — ex. nuvem atravessada por raio de sol, onde o depth
  // "pisca" entre perto/longe a cada 20-40px porque o modelo não resolve luz através de
  // névoa/nuvem. Reusa os 9 taps já amostrados pra d/edge, sem custo extra de textura.
  float wMean = d;
  float wVar = ((dC - wMean) * (dC - wMean) + (dR - wMean) * (dR - wMean) + (dL - wMean) * (dL - wMean)
              + (dU - wMean) * (dU - wMean) + (dD - wMean) * (dD - wMean)
              + (dTR - wMean) * (dTR - wMean) + (dTL - wMean) * (dTL - wMean)
              + (dBR - wMean) * (dBR - wMean) + (dBL - wMean) * (dBL - wMean)) / 9.0;
  float wideFiligree = clamp(wVar * 32.0, 0.0, 1.0);

  float atten = (1.0 - edge * 0.95) * (1.0 - filigree * 0.92) * (1.0 - wideFiligree * 0.95);
  // diferencial da translação (perto desloca mais) + diferencial do zoom (dolly em profundidade)
  // diferenciais contidos: acima de ~0.7 a borda de profundidade duplica o contorno ("fantasma")
  vec2 disp = (uOffset * 0.7 + (uv - 0.5) * (uZoom - 1.0) * 0.5) * uParallax * (d - 0.5) * atten;
  // teto de segurança: mesmo com parallax alto + depth instável, nunca desloca mais que ~3% do quadro
  float dispLen = length(disp);
  if (dispLen > 0.03) disp *= 0.03 / dispLen;
  vec2 suv = clamp(uv + disp, 0.0, 1.0);

  // aberração cromática proporcional ao movimento
  float ca = uChroma * 0.0012; // contido: 0.004 dobrava contornos visivelmente
  vec3 col;
  col.r = texture2D(uImage, clamp(suv + vec2(ca, 0.0), 0.0, 1.0)).r;
  col.g = texture2D(uImage, suv).g;
  col.b = texture2D(uImage, clamp(suv - vec2(ca, 0.0), 0.0, 1.0)).b;
  return col;
}

void main() {
  // 1) rotação (roll) em torno do centro, corrigindo aspecto
  vec2 uv = vUv - 0.5;
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  uv.x *= aspect;
  float cs = cos(uRotate), sn = sin(uRotate);
  uv = mat2(cs, -sn, sn, cs) * uv;
  uv.x /= aspect;

  // 2) zoom + 3) translação global da moldura
  uv = uv / uZoom + 0.5 + uOffset;

  // 4) amostra com parallax (+ blur direcional de 5 taps quando uBlur > 0)
  vec3 col;
  if (uBlur > 0.0005) {
    vec2 bdir = vec2(uBlur, 0.0);
    col = sampleScene(uv) * 0.30;
    col += sampleScene(uv + bdir * 0.5) * 0.20;
    col += sampleScene(uv - bdir * 0.5) * 0.20;
    col += sampleScene(uv + bdir) * 0.15;
    col += sampleScene(uv - bdir) * 0.15;
  } else {
    col = sampleScene(uv);
  }

  // 5) exposição + grade simples (lift/gain) + saturação
  col *= uExposure;
  col = col * uGain + uLift;
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(l), col, uSaturation);

  // 6) bloom barato: realça altas luzes
  if (uBloom > 0.0) {
    float hi = smoothstep(0.6, 1.0, l);
    col += hi * uBloom * 0.5;
  }

  // 7) vinheta
  vec2 q = vUv - 0.5;
  float vig = smoothstep(0.95, 0.25, length(q) * 1.35);
  col *= mix(1.0, vig, uVignette);

  // 8) grão de filme
  if (uGrain > 0.0) {
    float g = (hash(vUv * uResolution + fract(uTime)) - 0.5) * uGrain;
    col += g;
  }

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

// GNU Affero General Public License v3.0 — Copyright (c) 2026 Fair
// SPDX-License-Identifier: AGPL-3.0

// ============================================================
//  Chladni 方程与模式映射（纯数学，无 DOM 依赖）
// ============================================================

import {
  besselJ,
  circleZero,
} from "./bessel.js";

// 数值夹取
export function clamp(
  value,
  min,
  max,
) {
  return Math.max(
    min,
    Math.min(
      max,
      value,
    ),
  );
}

// --- 位移场模型：标准自由板克拉尼方程（无人工中心夹持） ---
// 直接采用自由板简正模（见 rawPsi / rawGradient），不在板心施加任何
// 强制节点或方向性约束——图案由方程本身自然决定，允许在板心出现波腹
// （如 m=n 偶数模），不做"绝对中心对称"的人工修正。
// 驱动能量从板心注入、向四周径向衰减（"震源在中间"）由 centerExcitation
// 包络在粒子层单独施加，不属于位移场约束。
// 中心激振包络：震源在板中心（激振器立轴顶入板心）→ 驱动能量
// 从中心点注入、向四周径向传播并随距离衰减；板边缘离源最远，
// 激励最弱。点源用欧氏距离（圆形等距波前）。
// 板心 r=0 → 1.0（最强），边中点 r=1 → 0.44，角 r=√2 → 0.3（下限）。
export function centerExcitation(
  u,
  v,
) {
  const x =
    2 * u - 1;
  const y =
    2 * v - 1;
  const r = Math.sqrt(
    x * x +
      y * y,
  ); // 0 = 板心（震源），√2 = 板角
  return (
    0.3 +
    0.7 *
      Math.max(
        0,
        1 -
          r *
            0.8,
      )
  );
}

// --- 位移场的唯一来源：ModeSpec 统一模型 ---
// 早期的 chladniPsi / blendedHeight / blendedHeightShape 等旧接口已删除：
// 位移场现在只有一条实现路径 —— squarePsi / circlePsi / polyPsi 由 specPsi
// 组装，再打包成定长数组供 JS / GLSL / WGSL 三端逐行同构地求值。

// --- 底板形状（克拉尼板外形）---
// 支持：正方形 / 圆形 / 等边三角形 / 正六边形。
// 坐标约定：所有形状都内接于以 (cx,cy)∈[-1,1] 为中心的同一正方形区域，
// 与粒子坐标 (x,y)∈[-1,1]、以及 u=(x+1)/2∈[0,1] 完全对应。
// 注：圆/三角/六边为「对称近似」的克拉尼模态（非严格本征函数），
// 用于艺术可视化——能产出具备该形状 Dn 对称性的节线图案即可。
export const PLATE_SHAPES = [
  "square",
  "circle",
  "triangle",
  "hexagon",
];

export function shapeIndex(
  shape,
) {
  const i =
    PLATE_SHAPES.indexOf(
      shape,
    );
  return i < 0
    ? 0
    : i;
}

// 三角/六边的对称方向（120° / 60° 均布），用于叠加余弦光栅
const TRI_DIRS = [
  [
    1,
    0,
  ],
  [
    -0.5,
    0.8660254,
  ],
  [
    -0.5,
    -0.8660254,
  ],
];
const HEX_DIRS = [];
for (
  let j = 0;
  j < 6;
  j++
) {
  const a =
    j *
    Math.PI /
    3;
  HEX_DIRS.push(
    [
      Math.cos(
        a,
      ),
      Math.sin(
        a,
      ),
    ],
  );
}

// 三角形内/外判定（顶点 A(0,1) B(-√3/2,-1/2) C(√3/2,-1/2)，叉积同侧法）
function _triSign(
  px,
  py,
  ax,
  ay,
  bx,
  by,
) {
  return (
    px -
      bx
  ) * (
    ay -
      by
  ) - (
    ax -
      bx
  ) * (
    py -
      by
  );
}
function inTriangle(
  x,
  y,
) {
  const d1 = _triSign(
    x,
    y,
    0,
    1,
    -0.8660254,
    -0.5,
  );
  const d2 = _triSign(
    x,
    y,
    -0.8660254,
    -0.5,
    0.8660254,
    -0.5,
  );
  const d3 = _triSign(
    x,
    y,
    0.8660254,
    -0.5,
    0,
    1,
  );
  const hasNeg =
    d1 < 0 ||
    d2 < 0 ||
    d3 < 0;
  const hasPos =
    d1 > 0 ||
    d2 > 0 ||
    d3 > 0;
  return !(
    hasNeg &&
    hasPos
  );
}
// 正六边形（顶点在 0/60/.../300°，外接半径 1）内/外判定
function inHexagon(
  x,
  y,
) {
  const c = 0.8660254; // √3/2
  return (
    Math.abs(
      y,
    ) <= c &&
    Math.abs(
      c * x +
        0.5 *
          y,
    ) <= c &&
    Math.abs(
      c * x -
        0.5 *
          y,
    ) <= c
  );
}

// 居中坐标 (cx,cy)∈[-1,1] 是否落在形状内部（粒子与底板渲染共用）
export function inShapeXY(
  cx,
  cy,
  shape,
) {
  switch (
    shape
  ) {
    case "circle":
      return (
        cx *
          cx +
        cy *
          cy <=
        1
      );
    case "triangle":
      return inTriangle(
        cx,
        cy,
      );
    case "hexagon":
      return inHexagon(
        cx,
        cy,
      );
    default:
      return (
        Math.abs(
          cx,
        ) <= 1 &&
        Math.abs(
          cy,
        ) <= 1
      );
  }
}

// ---------- 边界投影（贴边堆积用） ----------
// 线段 (ax,ay)-(bx,by) 上离 (px,py) 最近的点
function _projSeg(
  px,
  py,
  ax,
  ay,
  bx,
  by,
) {
  const abx =
    bx -
    ax;
  const aby =
    by -
    ay;
  const denom =
    abx *
      abx +
    aby *
      aby;
  let t = 0;
  if (
    denom >
    1e-9
  )
    t =
      (
        (
          px -
          ax
        ) *
          abx +
        (
          py -
          ay
        ) *
          aby
      ) /
      denom;
  t =
    Math.max(
      0,
      Math.min(
        1,
        t,
      ),
    );
  return {
    x:
      ax +
      abx *
        t,
    y:
      ay +
      aby *
        t,
  };
}

// 形状边段（圆板返回 null，单独处理）。顶点须与 inTriangle/inHexagon、GLSL/WGSL 多边形几何完全一致。
function _shapeEdges(
  shape,
) {
  if (
    shape ===
    "square"
  )
    return [
      [
        -1,
        -1,
        1,
        -1,
      ],
      [
        1,
        -1,
        1,
        1,
      ],
      [
        1,
        1,
        -1,
        1,
      ],
      [
        -1,
        1,
        -1,
        -1,
      ],
    ];
  if (
    shape ===
    "triangle"
  ) {
    const A = [
      0,
      1,
    ];
    const B = [
      -0.8660254,
      -0.5,
    ];
    const C = [
      0.8660254,
      -0.5,
    ];
    return [
      [
        ...A,
        ...B,
      ],
      [
        ...B,
        ...C,
      ],
      [
        ...C,
        ...A,
      ],
    ];
  }
  if (
    shape ===
    "hexagon"
  ) {
    const v = [];
    for (
      let j = 0;
      j < 6;
      j++
    ) {
      const a =
        j *
        Math.PI /
        3;
      v.push(
        [
          Math.cos(
            a,
          ),
          Math.sin(
            a,
          ),
        ],
      );
    }
    const e = [];
    for (
      let j = 0;
      j < 6;
      j++
    ) {
      const a = v[
        j
      ];
      const b = v[
        (
          j +
          1
        ) %
        6
      ];
      e.push(
        [
          a[
            0
          ],
          a[
            1
          ],
          b[
            0
          ],
          b[
            1
          ],
        ],
      );
    }
    return e;
  }
  return null; // circle
}

// 返回形状边界上离 (cx,cy) 最近的点，并附带到边界的距离与内外标志。
// 内/外点通用：圆板直接归一化到半径 1；多边形枚举边段求最近投影点。
// 返回的 x,y 为最近边界点；d 为到边界的欧氏距离；inside 为是否落在形状内部。
export function boundaryProject(
  cx,
  cy,
  shape,
) {
  const edges =
    _shapeEdges(
      shape,
    );
  if (
    !edges
  ) {
    // 圆板
    const r =
      Math.hypot(
        cx,
        cy,
      );
    if (
      r <
      1e-6
    )
      return {
        x: 1,
        y: 0,
        d: 1,
        inside: true,
      };
    const ix =
      cx /
      r;
    const iy =
      cy /
      r;
    return {
      x: ix,
      y: iy,
      d: Math.abs(
        1 -
          r,
      ),
      inside:
        r <= 1,
    };
  }
  let bx = cx;
  let by = cy;
  let bd2 = Infinity;
  for (
    const e of edges
  ) {
    const pr = _projSeg(
      cx,
      cy,
      e[
        0
      ],
      e[
        1
      ],
      e[
        2
      ],
      e[
        3
      ],
    );
    const dx =
      pr.x -
      cx;
    const dy =
      pr.y -
      cy;
    const d2 =
      dx *
        dx +
      dy *
        dy;
    if (
      d2 <
      bd2
    ) {
      bd2 = d2;
      bx = pr.x;
      by = pr.y;
    }
  }
  return {
    x: bx,
    y: by,
    d: Math.sqrt(
      bd2,
    ),
    inside: inShapeXY(
      cx,
      cy,
      shape,
    ),
  };
}

// 到边界的有符号距离：形状内部为负、外部为正（贴边吸附的带判定用）
export function boundaryDist(
  cx,
  cy,
  shape,
) {
  const bp = boundaryProject(
    cx,
    cy,
    shape,
  );
  return bp.inside
    ? -bp.d
    : bp.d;
}

// 正方形位移场（带符号变体）。
// sign < 0：经典差形式（反对称组合，对角为节线）
// sign ≥ 0：和形式（cos 项相加 → 另一类真实物理图样）
// m == n：乘积形式（两者等价）
export function squarePsi(
  u,
  v,
  m,
  n,
  sign,
) {
  if (
    Math.abs(
      m -
        n,
    ) <
    0.5
  ) {
    return (
      Math.cos(
        m *
          Math.PI *
          u,
      ) *
      Math.cos(
        n *
          Math.PI *
          v,
      )
    );
  }
  if (
    sign >=
    0
  ) {
    return (
      Math.cos(
        n *
          Math.PI *
          u,
      ) *
        Math.cos(
          m *
            Math.PI *
            v,
        ) +
      Math.cos(
        m *
          Math.PI *
          u,
      ) *
        Math.cos(
          n *
            Math.PI *
            v,
        )
    );
  }
  return (
    Math.cos(
      n *
        Math.PI *
        u,
    ) *
      Math.cos(
        m *
          Math.PI *
          v,
      ) -
    Math.cos(
      m *
        Math.PI *
        u,
    ) *
      Math.cos(
        n *
          Math.PI *
          v,
      )
  );
}

// 圆形位移场（精确自由板本征函数）：ψ = J_n(z·r)·cos(nθ)
// nAng = 角向阶（辐射节线数），nRad = 径向序号（同心节圆数）
export function circlePsi(
  cx,
  cy,
  nRad,
  nAng,
) {
  const r =
    Math.sqrt(
      cx *
        cx +
      cy *
        cy,
    );
  const th = Math.atan2(
    cy,
    cx,
  );
  const z = circleZero(
    nAng,
    nRad,
  );
  const ang =
    nAng ===
    0
      ? 1
      : Math.cos(
        nAng * th,
      );
  return (
    besselJ(
      nAng,
      z * r,
    ) * ang
  );
}

// 三角/六边共用：D_n 对称余弦光栅之差（艺术近似）
function polyPsi(
  cx,
  cy,
  m,
  n,
  shape,
) {
  let s = 0;
  const dirs =
    shape ===
    "triangle"
      ? TRI_DIRS
      : HEX_DIRS;
  for (
    const d of dirs
  ) {
    const p =
      cx *
        d[0] +
      cy *
        d[1];
    s +=
      Math.cos(
        m * p,
      ) -
      Math.cos(
        n * p,
      );
  }
  return s;
}


// ============================================================
//  ModeSpec — 统一模式描述（正方形符号/退化叠加 · 圆形贝塞尔 · 多边形光栅）
//  渲染与物理三路径（JS / GLSL / WGSL）共用同一份打包数据，避免数学三处重复。
//    square: { shape:"square", terms:[{m,n,sign}] }  sign ∈ {+1,−1}
//    circle: { shape:"circle", nAng, nRad }           nAng 角向 / nRad 径向序号
//    triangle/hexagon: { shape, m, n }
// ============================================================

// 正方形单模式（sign 默认 −1：经典差形式）
export function makeSquareSpec(
  m,
  n,
  sign = -1,
) {
  return {
    shape: "square",
    terms: [
      {
        m,
        n,
        sign:
          sign >= 0
            ? 1
            : -1,
      },
    ],
  };
}

export function makeCircleSpec(
  nAng,
  nRad,
) {
  return {
    shape: "circle",
    nAng: clamp(
      nAng,
      0,
      12,
    ),
    nRad: clamp(
      nRad,
      1,
      12,
    ),
  };
}

export function makePolySpec(
  m,
  n,
  shape,
) {
  return {
    shape,
    m,
    n,
  };
}

// 位移场归一化尺度：让不同形状 / 不同叠加项数的 |ψ| 峰值都落在 ≈2
// （沿用方板单模式的历史量纲），这样节线粗细公式 exp(−h²·k) 与
// 粒子受力强度在四种底板之间保持一致，不会出现「圆板线极粗、
// 画廊叠加线极细」的失衡。
export function specScale(
  spec,
) {
  if (
    spec.shape ===
    "square"
  ) {
    // 方板峰值可解析给出（板角 u=v=0 处所有 cos 取 1）：
    //   m≠n 项峰值 2（和/差形式），m=n 项峰值 1（乘积形式）
    // 退化叠加时各项在角上同号相加 → 总峰值即各项峰值之和。
    let denom = 0;
    for (
      const term of spec.terms
    )
      denom +=
        Math.abs(
          term.m -
            term.n,
        ) < 0.5
          ? 1
          : 2;
    return (
      2 /
      Math.max(
        1e-6,
        denom,
      )
    );
  }
  if (
    spec.shape ===
    "circle"
  ) {
    // 采样 J_n(z·r)（r∈[0,1]）取峰值，缩放到峰值 2
    const z = circleZero(
      spec.nAng,
      spec.nRad,
    );
    let peak = 1e-6;
    for (
      let i = 0;
      i <= 64;
      i++
    ) {
      const a = Math.abs(
        besselJ(
          spec.nAng,
          (z * i) /
            64,
        ),
      );
      if (
        a >
        peak
      )
        peak = a;
    }
    return (
      2 / peak
    );
  }
  // 多边形光栅：各方向相干叠加，理论上界远达不到 → 在形状内采样求实际峰值
  let pk = 1e-6;
  for (
    let i = 0;
    i <= 48;
    i++
  ) {
    for (
      let j = 0;
      j <= 48;
      j++
    ) {
      const cx =
        (i / 48) *
          2 -
        1;
      const cy =
        (j / 48) *
          2 -
        1;
      if (
        !inShapeXY(
          cx,
          cy,
          spec.shape,
        )
      )
        continue;
      const a = Math.abs(
        polyPsi(
          cx,
          cy,
          spec.m,
          spec.n,
          spec.shape,
        ),
      );
      if (
        a >
        pk
      )
        pk = a;
    }
  }
  return (
    2 / pk
  );
}

// 取（并缓存）某个 spec 的归一化尺度
function scaleOf(
  spec,
) {
  if (
    spec._scale ===
    undefined
  )
    spec._scale = specScale(
      spec,
    );
  return spec._scale;
}

// 模式位移场 ψ(u,v)（u,v∈[0,1]），带符号，已归一化
export function specPsi(
  spec,
  u,
  v,
) {
  const k = scaleOf(
    spec,
  );
  if (
    spec.shape ===
    "square"
  ) {
    let s = 0;
    for (
      const term of spec.terms
    ) {
      s +=
        term.sign *
        squarePsi(
          u,
          v,
          term.m,
          term.n,
          term.sign,
        );
    }
    return s * k;
  }
  const cx =
    2 * u -
    1;
  const cy =
    2 * v -
    1;
  if (
    spec.shape ===
    "circle"
  )
    return (
      circlePsi(
        cx,
        cy,
        spec.nRad,
        spec.nAng,
      ) * k
    );
  return (
    polyPsi(
      cx,
      cy,
      spec.m,
      spec.n,
      spec.shape,
    ) * k
  );
}

// 模式位移场梯度（数值差分，对所有形状通用）
function specGrad(
  spec,
  u,
  v,
) {
  const e = 1e-3;
  const hx =
    specPsi(
      spec,
      u + e,
      v,
    ) -
    specPsi(
      spec,
      u - e,
      v,
    );
  const hy =
    specPsi(
      spec,
      u,
      v + e,
    ) -
    specPsi(
      spec,
      u,
      v - e,
    );
  return {
    dx:
      hx /
      (2 * e),
    dy:
      hy /
      (2 * e),
  };
}

// 混合高度场 H = (1−t)·|ψ(prev)| + t·|ψ(cur)|
export function blendedSpecHeight(
  u,
  v,
  prevSpec,
  curSpec,
  t,
) {
  const hc = Math.abs(
    specPsi(
      curSpec,
      u,
      v,
    ),
  );
  if (
    t >=
    1
  )
    return hc;
  const hp = Math.abs(
    specPsi(
      prevSpec,
      u,
      v,
    ),
  );
  return (
    hp *
      (1 - t) +
    hc * t
  );
}

// 混合高度场梯度（∇|ψ| = sign(ψ)·∇ψ）
export function blendedSpecGrad(
  u,
  v,
  prevSpec,
  curSpec,
  t,
) {
  const psic = specPsi(
    curSpec,
    u,
    v,
  );
  const gc = specGrad(
    curSpec,
    u,
    v,
  );
  const sc =
    psic >=
    0
      ? 1
      : -1;
  if (
    t >=
    1
  )
    return {
      dx:
        sc *
        gc.dx,
      dy:
        sc *
        gc.dy,
    };
  const psip = specPsi(
    prevSpec,
    u,
    v,
  );
  const gp = specGrad(
    prevSpec,
    u,
    v,
  );
  const sp =
    psip >=
    0
      ? 1
      : -1;
  return {
    dx:
      sp *
        gp.dx *
        (1 - t) +
      sc *
        gc.dx *
        t,
    dy:
      sp *
        gp.dy *
        (1 - t) +
      sc *
        gc.dy *
        t,
  };
}

// --- 打包（供 GLSL/WGSL 着色器消费） ---
export const SQ_MAX = 8; // 正方形退化叠加最多 8 项（k≤800 下表示数足够）

export function packSpec(
  spec,
) {
  const p = {
    shapeIdx: shapeIndex(
      spec.shape,
    ),
    scale: scaleOf(
      spec,
    ),
    sqLen: 0,
    sqM: new Array(
      SQ_MAX,
    ).fill(
      0,
    ),
    sqN: new Array(
      SQ_MAX,
    ).fill(
      0,
    ),
    sqS: new Array(
      SQ_MAX,
    ).fill(
      -1,
    ),
    cirN: 0,
    cirZ: 0,
    polyM: 0,
    polyN: 0,
  };
  if (
    spec.shape ===
    "square"
  ) {
    const terms = spec.terms.slice(
      0,
      SQ_MAX,
    );
    p.sqLen = terms.length;
    terms.forEach(
      (
        term,
        i,
      ) => {
        p.sqM[i] = term.m;
        p.sqN[i] = term.n;
        p.sqS[i] = term.sign;
      },
    );
  } else if (
    spec.shape ===
    "circle"
  ) {
    p.cirN = spec.nAng;
    p.cirZ = circleZero(
      spec.nAng,
      spec.nRad,
    );
  } else {
    p.polyM = spec.m;
    p.polyN = spec.n;
  }
  return p;
}

// 将 prev+cur 打包成定长 Float32Array（供 GLSL uniform / WGSL storage buffer）
// 每个 spec 占 31 个 float，布局：
//   [0] shapeIdx  [1] sqLen  [2] scale
//   [3..10] sqM   [11..18] sqN   [19..26] sqS
//   [27] cirN  [28] cirZ  [29] polyM  [30] polyN
// prev 在 [0..30]，cur 在 [31..61]，总长 SPEC_FLOATS = 62。
export const SPEC_STRIDE = 31;
export const SPEC_FLOATS = 62;

export function flattenSpecs(
  prevP,
  curP,
) {
  const a = new Float32Array(
    SPEC_FLOATS,
  );
  let o = 0;
  a[o++] = prevP.shapeIdx;
  a[o++] = prevP.sqLen;
  a[o++] = prevP.scale;
  for (
    let i = 0;
    i < SQ_MAX;
    i++
  )
    a[o++] = prevP.sqM[i];
  for (
    let i = 0;
    i < SQ_MAX;
    i++
  )
    a[o++] = prevP.sqN[i];
  for (
    let i = 0;
    i < SQ_MAX;
    i++
  )
    a[o++] = prevP.sqS[i];
  a[o++] = prevP.cirN;
  a[o++] = prevP.cirZ;
  a[o++] = prevP.polyM;
  a[o++] = prevP.polyN;
  a[o++] = curP.shapeIdx;
  a[o++] = curP.sqLen;
  a[o++] = curP.scale;
  for (
    let i = 0;
    i < SQ_MAX;
    i++
  )
    a[o++] = curP.sqM[i];
  for (
    let i = 0;
    i < SQ_MAX;
    i++
  )
    a[o++] = curP.sqN[i];
  for (
    let i = 0;
    i < SQ_MAX;
    i++
  )
    a[o++] = curP.sqS[i];
  a[o++] = curP.cirN;
  a[o++] = curP.cirZ;
  a[o++] = curP.polyM;
  a[o++] = curP.polyN;
  return a;
}

// --- 打包数组求值（CPU 侧，与 GLSL / WGSL 逐行同构）---
// Worker 通过结构化克隆只能拿到 Float32Array（ModeSpec 里的
// terms 数组与缓存尺度不便传递），因此 CPU 物理与 CPU 渲染回退
// 统一直接在打包数组上求值：三条路径（JS / GLSL / WGSL）共用同一
// 份布局与同一套公式，圆板贝塞尔、方板符号/退化叠加、多边形光栅
// 在任何渲染后端下都得到完全一致的图形。
// base = 0 取 prev，base = SPEC_STRIDE 取 cur。
export function packedPsi(
  a,
  base,
  u,
  v,
) {
  const shape = a[base];
  const scale = a[base + 2];
  if (shape < 0.5) {
    const len = Math.min(SQ_MAX, (a[base + 1] + 0.5) | 0);
    let s = 0;
    for (let i = 0; i < len; i++) {
      const sgn = a[base + 19 + i];
      s += sgn * squarePsi(u, v, a[base + 3 + i], a[base + 11 + i], sgn);
    }
    return s * scale;
  }
  const cx = 2 * u - 1;
  const cy = 2 * v - 1;
  if (shape < 1.5) {
    // 圆板精确本征函数：J_n(z_{n,m}·r)·cos(nθ)
    const nAng = Math.round(a[base + 27]);
    const z = a[base + 28];
    const r = Math.sqrt(cx * cx + cy * cy);
    const ang = nAng === 0 ? 1 : Math.cos(nAng * Math.atan2(cy, cx));
    return besselJ(nAng, z * r) * ang * scale;
  }
  return (
    polyPsi(
      cx,
      cy,
      a[base + 29],
      a[base + 30],
      shape < 2.5 ? "triangle" : "hexagon",
    ) * scale
  );
}

// 混合高度场 H = (1−t)·|ψ(prev)| + t·|ψ(cur)|（打包版）
export function packedHeight(
  a,
  u,
  v,
  t,
) {
  const hc = Math.abs(packedPsi(a, SPEC_STRIDE, u, v));
  if (t >= 1) return hc;
  const hp = Math.abs(packedPsi(a, 0, u, v));
  return hp * (1 - t) + hc * t;
}

// 混合高度场梯度（中心差分，与 WGSL specGrad 完全一致）。
// 返回复用对象，调用方须立即取值，勿长期持有。
const _packedGrad = {
  dx: 0,
  dy: 0,
};
export function packedGrad(
  a,
  u,
  v,
  t,
) {
  const e = 1e-3;
  _packedGrad.dx =
    (packedHeight(a, u + e, v, t) - packedHeight(a, u - e, v, t)) / (2 * e);
  _packedGrad.dy =
    (packedHeight(a, u, v + e, t) - packedHeight(a, u, v - e, t)) / (2 * e);
  return _packedGrad;
}

// 默认打包描述（方板 3×4 差形式），供各线程在收到首帧 spec 之前兜底
export function defaultPackedSpec() {
  const p = packSpec(
    makeSquareSpec(
      3,
      4,
      -1,
    ),
  );
  return flattenSpecs(
    p,
    p,
  );
}

// ============================================================
//  图案画廊（方板退化模态目录，参考 hilbertcube/Chladni-Patterns-Generator）
//  枚举所有唯一本征值 k = m²+n²（m,n∈[1,100], n≥m），同 k 的全部 (a,b) 对
//  以 + 号线性叠加 → 真实克拉尼退化模态组合。按 k 升序编号，用户翻图册浏览。
// ============================================================
export const GALLERY = (() => {
  const map = new Map();
  for (
    let m = 1;
    m <= 100;
    m++
  ) {
    for (
      let n = m;
      n <= 100;
      n++
    ) {
      const k =
        m *
          m +
        n *
        n;
      if (
        !map.has(
          k,
        )
      )
        map.set(
          k,
          [],
        );
      map.get(
        k,
      ).push(
        {
          m,
          n,
        },
      );
    }
  }
  const ks = [
    ...map.keys(),
  ].sort(
    (
      a,
      b,
    ) => a - b,
  );
  return ks.map(
    (
      k,
    ) => ({
      k,
      pairs: map.get(
        k,
      ),
    }),
  );
})();

export function galleryCount() {
  return GALLERY.length;
}

export function gallerySpec(
  i,
) {
  const entry = GALLERY[
    Math.max(
      0,
      Math.min(
        GALLERY.length - 1,
        i | 0,
      ),
    )
  ];
  const terms = entry.pairs.map(
    (
      p,
    ) => ({
      m: p.m,
      n: p.n,
      sign: 1,
    }),
  );
  return {
    shape: "square",
    terms,
  };
}

export function galleryLabel(
  i,
) {
  const entry = GALLERY[
    Math.max(
      0,
      Math.min(
        GALLERY.length - 1,
        i | 0,
      ),
    )
  ];
  return {
    k: entry.k,
    pairs: entry.pairs,
    count: entry.pairs.length,
  };
}

// 解析 "m,n" 格式（如 "2,3"），范围限制 1..100
export function parseSquareMode(
  mode,
) {
  const match =
    /^(\d+),(\d+)$/.exec(
      mode,
    );
  if (
    !match
  ) {
    return null;
  }
  const m =
    Number(
      match[1],
    );
  const n =
    Number(
      match[2],
    );
  if (
    m <
      1 ||
    m >
      100 ||
    n <
      1 ||
    n >
      100
  ) {
    return null;
  }
  return {
    m,
    n,
  };
}

// 规范化模式字符串（小写、去空格），非法值回退 auto
export function normalizeModeValue(
  value,
) {
  if (
    value ===
    "auto"
  ) {
    return "auto";
  }
  if (
    typeof value !==
    "string"
  ) {
    return "auto";
  }
  const normalized =
    value
      .trim()
      .toLowerCase()
      .replace(
        /\s+/g,
        "",
      );
  const parsedSquare =
    parseSquareMode(
      normalized,
    );
  if (
    parsedSquare !==
    null
  ) {
    return `${parsedSquare.m},${parsedSquare.n}`;
  }
  return "auto";
}

// --- 频率 → 模式映射（含板尺寸与硬度物理修正） ---
// 物理定律：方形板弯曲振动基频 f(m,n) = f₀·(m²+n²)·(L₀/L)²·√(s/s₀)
//   · 板越大(L↑) → 同模式频率越低（∝ 1/L²）
//   · 板越硬(s↑) → 同模式频率越高（∝ √s）
// f₀=55Hz 为参考基准（L₀=40cm, s₀=1）时的 (1,2) 模式频率
export function freqToMode(
  freq,
  opts = {},
) {
  const plateCm =
    opts.plateCm ??
    40;
  const stiffness =
    opts.stiffness ??
    1;
  const boundedFreq =
    clamp(
      freq,
      20,
      50000,
    );
  const baseFreq = 55;
  const refCm = 40;
  const refStiff = 1;
  // 反推目标 (m²+n²) = (f/f₀)·(L/L₀)²·√(s₀/s)
  const targetSum =
    (boundedFreq /
      baseFreq) *
    Math.pow(
      plateCm /
        refCm,
      2,
    ) *
    Math.sqrt(
      refStiff /
        Math.max(
          0.01,
          stiffness,
        ),
    );
  let bestM = 1;
  let bestN = 2;
  let bestDiff =
    Infinity;

  for (
    let m = 1;
    m <=
      100;
    m++
  ) {
    for (
      let n =
        m;
      n <=
        100;
      n++
    ) {
      // Skip degenerate (1,1) — no pattern
      if (
        m ===
          1 &&
        n ===
          1
      )
        continue;
      const sum =
        m *
          m +
        n *
          n;
      const diff =
        Math.abs(
          sum -
            targetSum,
        );
      if (
        diff <
        bestDiff
      ) {
        bestDiff =
          diff;
        bestM =
          m;
        bestN =
          n;
      }
    }
  }
  return {
    m: bestM,
    n: bestN,
  };
}

// 反向：给定模式与板参数，求共振频率（用于 INFO 实时显示）
export function modeToFreq(
  m,
  n,
  opts = {},
) {
  const plateCm =
    opts.plateCm ??
    40;
  const stiffness =
    opts.stiffness ??
    1;
  const baseFreq = 55;
  const refCm = 40;
  const refStiff = 1;
  return (
    baseFreq *
    (m *
       m +
      n *
        n) *
    Math.pow(
      refCm /
        plateCm,
      2,
    ) *
    Math.sqrt(
      stiffness /
        refStiff,
    )
  );
}

// 将模式值转为显示文本（如 "5,5" → "5×5"，auto → "AUTOMATIC"）
// UI 约定：英文一律用完整单词，不用缩写
export function modeLabelText(
  selectedMode,
) {
  if (
    selectedMode ===
    "auto"
  ) {
    return "AUTOMATIC";
  }
  return selectedMode.replace(
    ",",
    "×",
  );
}

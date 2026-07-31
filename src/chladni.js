// MIT License — Copyright (c) 2026 Fair
// SPDX-License-Identifier: MIT

// ============================================================
//  Chladni 方程与模式映射（纯数学，无 DOM 依赖）
// ============================================================

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

// --- 克拉尼方程（标准教科书形式，不做任何人为修饰） ---
// 同模 (m=n)：乘积形式 ψ = cos(mπu)·cos(nπv)
//   → m×m 网格节线（差形式在 m=n 时恒为 0，故用乘积；等价于和形式 ÷2）
// 异模 (m≠n)：经典差形式 ψ = cos(nπu)cos(mπv) − cos(mπu)cos(nπv)
//   这是方形自由板简并模对 (m,n)/(n,m) 的反对称组合，即文献与实物
//   克拉尼板上最常观察到的图形。注意：ψ(x,y) = −ψ(y,x) ⇒ 主对角线
//   x=y 恒为节线——这是真实物理（沙粒确实会聚在对角线上），不是伪影，
//   不做删除或减弱。
// 自由板模式形状（即最终位移场，无中心夹持）
function rawPsi(
  u,
  v,
  m,
  n,
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
  // 异模 (m≠n)：标准差形式（k = −1，无人为系数）
  //   ψ = cos(nπu)cos(mπv) − cos(mπu)cos(nπv)
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

// 位移场：直接使用自由板方程（不再乘中心夹持窗）
export function chladniPsi(
  u,
  v,
  m,
  n,
) {
  return rawPsi(
    u,
    v,
    m,
    n,
  );
}

// 自由板模式形状梯度（即最终位移场梯度，无中心夹持）
function rawGradient(
  u,
  v,
  m,
  n,
) {
  if (
    Math.abs(
      m -
        n,
    ) <
    0.5
  ) {
    // 乘积形式梯度：∂(a·b)/∂u = a'·b，∂(a·b)/∂v = a·b'
    const au =
      Math.cos(
        m *
          Math.PI *
          u,
      );
    const bv =
      Math.cos(
        n *
          Math.PI *
          v,
      );
    const auPrime =
      -m *
      Math.PI *
      Math.sin(
        m *
          Math.PI *
          u,
      );
    const bvPrime =
      -n *
      Math.PI *
      Math.sin(
        n *
          Math.PI *
          v,
      );
    return {
      dx:
        auPrime *
        bv,
      dy:
        au *
        bvPrime,
    };
  }
  // 标准差形式梯度：ψ = cos(nπu)cos(mπv) − cos(mπu)cos(nπv)
  //   ∂/∂u = −nπ·sin(nπu)cos(mπv) + mπ·sin(mπu)cos(nπv)
  //   ∂/∂v = −mπ·cos(nπu)sin(mπv) + nπ·cos(mπu)sin(nπv)
  return {
    dx:
      Math.PI *
      (-n *
        Math.sin(
          n *
            Math.PI *
            u,
        ) *
        Math.cos(
          m *
            Math.PI *
            v,
        ) +
        m *
          Math.sin(
            m *
              Math.PI *
              u,
          ) *
          Math.cos(
            n *
              Math.PI *
              v,
          )),
    dy:
      Math.PI *
      (-m *
        Math.cos(
          n *
            Math.PI *
            u,
        ) *
        Math.sin(
          m *
            Math.PI *
            v,
        ) +
        n *
          Math.cos(
            m *
              Math.PI *
              u,
          ) *
          Math.sin(
            n *
              Math.PI *
              v,
          )),
  };
}

// 位移场解析梯度：直接取自由板方程梯度（与 chladniPsi 严格一致）
export function chladniGradient(
  u,
  v,
  m,
  n,
) {
  return rawGradient(
    u,
    v,
    m,
    n,
  );
}

// --- 混合高度场（保持中心对称的模式过渡） ---
// 关键：克拉尼方程只有在 m、n 为整数时才关于板中心对称
//（cos(mπ(1−u)) = ±cos(mπu) 仅当 m∈ℤ）。因此模式切换不能用
// 小数 (m,n) 连续插值，而是对"两个整数模式的 |ψ| 高度场"做
// 交叉淡入——每个整数模式都中心对称，线性混合后依然中心对称。

// 混合海拔：H = (1−t)·|ψ(pm,pn)| + t·|ψ(cm,cn)|
export function blendedHeight(
  u,
  v,
  pm,
  pn,
  cm,
  cn,
  t,
) {
  const hc = Math.abs(
    chladniPsi(
      u,
      v,
      cm,
      cn,
    ),
  );
  if (
    t >=
    1
  ) {
    return hc;
  }
  const hp = Math.abs(
    chladniPsi(
      u,
      v,
      pm,
      pn,
    ),
  );
  return (
    hp *
      (1 -
        t) +
    hc *
      t
  );
}

// 混合海拔的梯度：∇H = (1−t)·sign(ψp)·∇ψp + t·sign(ψc)·∇ψc
//（∇|ψ| = sign(ψ)·∇ψ 几乎处处成立）
export function blendedHeightGradient(
  u,
  v,
  pm,
  pn,
  cm,
  cn,
  t,
) {
  const psiC =
    chladniPsi(
      u,
      v,
      cm,
      cn,
    );
  const gC =
    chladniGradient(
      u,
      v,
      cm,
      cn,
    );
  const sC =
    psiC >=
    0
      ? 1
      : -1;
  if (
    t >=
    1
  ) {
    return {
      dx:
        sC *
        gC.dx,
      dy:
        sC *
        gC.dy,
    };
  }
  const psiP =
    chladniPsi(
      u,
      v,
      pm,
      pn,
    );
  const gP =
    chladniGradient(
      u,
      v,
      pm,
      pn,
    );
  const sP =
    psiP >=
    0
      ? 1
      : -1;
  return {
    dx:
      sP *
        gP.dx *
        (1 -
          t) +
      sC *
        gC.dx *
        t,
    dy:
      sP *
        gP.dy *
        (1 -
          t) +
      sC *
        gC.dy *
        t,
  };
}

// 解析 "m,n" 格式（如 "2,3"），范围限制 1..15
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
      15 ||
    n <
      1 ||
    n >
      15
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
    15;
    m++
  ) {
    for (
      let n =
        m;
      n <=
      15;
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

// GNU Affero General Public License v3.0 — Copyright (c) 2026 Fair
// SPDX-License-Identifier: AGPL-3.0

// ============================================================
//  bessel.js — 贝塞尔函数与自由圆板本征值
//  自由圆板（周边自由）克拉尼模态的径向部分由贝塞尔函数本征函数给出：
//      ψ(r,θ) = J_n(z_{n,m} · r) · cos(nθ)
//  其中 z_{n,m} 是 J_n'(x) 的第 m 个正零点（自由边条件 ψ'|_{r=1}=0）。
//  J_n'(x) 的零点非等距，故圆形节圆不能简单用 cos(m·π·r) 近似——这是本项目
//  早期圆板实现的物理错误所在，本模块提供精确计算。
// ============================================================

// 计算整数阶第一类贝塞尔函数 J_n(x)。
// 采用 Miller 向下递推（稳定，对任意 x、n 都可用）：
//   自某个足够大的阶 M 起用任意种子向下递推到 0 阶，
//   再用归一化恒等式 J_0 + 2J_2 + 2J_4 + … = 1 修正幅值。
export function besselJ(
  n,
  x,
) {
  if (
    x ===
    0
  )
    return n ===
      0
      ? 1
      : 0;
  const ax = Math.abs(
    x,
  );
  const M = n + 40; // M ≫ x 保证递推落在下降稳定区
  let jPrev = 0; // j_{k+1}
  let jCur = 1; // j_k（初值 j_M = 1）
  let jn = 0; // 目标 J_n（未归一化）
  let sum = 0; // 归一化和：j_0 + 2(j_2 + j_4 + …)
  const invX = 2 /
    ax;
  for (
    let k = M;
    k >= 1;
    k--
  ) {
    const jNew = invX *
      k *
      jCur -
      jPrev; // j_{k-1} = (2k/x)·j_k − j_{k+1}
    const idx = k - 1;
    if (
      idx ===
      n
    )
      jn = jNew;
    if (
      idx ===
      0
    )
      sum += jNew;
    else if (
      idx %
        2 ===
      0
    )
      sum += 2 *
        jNew;
    jPrev = jCur;
    jCur = jNew;
  }
  // 循环结束时 jCur = j_0（未归一化）；n==0 时直接取之
  if (
    n ===
    0
  )
    jn = jCur;
  return jn /
    sum;
}

// J_n'(x) = (J_{n-1}(x) − J_{n+1}(x)) / 2（递推关系，精确）
export function besselJPrime(
  n,
  x,
) {
  return (
    besselJ(
      n - 1,
      x,
    ) -
    besselJ(
      n + 1,
      x,
    )
  ) *
    0.5;
}

// --- 预建 J_n' 正零点表（自由圆板径向本征值） ---
// ZEROS[n] = [z_{n,1}, z_{n,2}, …]（第 1、2、… 个正零点）。
// 扫描 J_n'(x) 符号变化并二分细化；n≥2 时 x=0 亦是零点，故从 x=0.05 起
// 只收集正的非零零点。
const NMAX = 12; // 最大角向阶 n
const MMAX = 12; // 每个 n 取前 MMAX 个径向零点

function buildZeros() {
  const table = [];
  for (
    let n = 0;
    n <= NMAX;
    n++
  ) {
    const zeros = [];
    let x = 0.05;
    // 扫描上界：J_n' 第 m 个零点约 ~ (m + n/2)·π，留足余量
    const xMax = (MMAX + n / 2 + 2) *
      Math.PI;
    let prev = besselJPrime(
      n,
      x,
    );
    while (
      zeros.length <
        MMAX &&
      x < xMax
    ) {
      const step = 0.01;
      const x2 = x + step;
      const cur = besselJPrime(
        n,
        x2,
      );
      if (
        prev ===
          0 ||
        (prev < 0 !== cur < 0)
      ) {
        // 二分细化零点
        let a = x;
        let b = x2;
        let fa = prev;
        for (
          let it = 0;
          it < 60;
          it++
        ) {
          const mid = (a + b) /
            2;
          const fm = besselJPrime(
            n,
            mid,
          );
          if (
            fa ===
              0 ||
            (fa < 0 !== fm < 0)
          ) {
            b = mid;
          } else {
            a = mid;
            fa = fm;
          }
        }
        const z = (a + b) /
          2;
        if (
          z >
          1e-4
        )
          zeros.push(
            z,
          );
      }
      prev = cur;
      x = x2;
    }
    // 不足则补（理论上不会）：用渐近估计填充
    while (
      zeros.length <
      MMAX
    ) {
      const m = zeros.length + 1;
      zeros.push(
        (m + n / 2 - 0.25) *
          Math.PI,
      );
    }
    table.push(
      zeros,
    );
  }
  return table;
}

export const ZEROS = buildZeros();

// 取自由圆板 (角向阶 nAng, 径向序号 nRad 从 1 起) 的本征值 z_{n,m}
export function circleZero(
  nAng,
  nRad,
) {
  const na = Math.max(
    0,
    Math.min(
      NMAX,
      nAng | 0,
    ),
  );
  const mr = Math.max(
    1,
    Math.min(
      MMAX,
      nRad | 0,
    ),
  );
  const row = ZEROS[na];
  return row[
    mr - 1
  ];
}

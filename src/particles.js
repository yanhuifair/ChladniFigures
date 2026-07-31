// MIT License — Copyright (c) 2026 Fair
// SPDX-License-Identifier: MIT

// ============================================================
//  ParticleSystem — 沙粒粒子系统（跳-停走动模型）
//  真实克拉尼沙粒并非连续滑动，而是被震动的板面反复抛起：
//  每次弹跳落点略偏向下坡（节线方向），宏观上呈"一步步走动"。
//  状态机：着板（静摩擦，可沉降）⇄ 腾空（弹道小跳跃）
//  接收 field 提供 psiAt / gradAt / vibration / treble / kick
// ============================================================

// 颗粒碰撞参数（短程斥力 → 沙粒不可重叠，节线处堆成有宽度的沙带）
const COLLIDE_R = 0.006;     // 归一化碰撞半径基准（实际半径 = COLLIDE_R * sizeF）
const COLLIDE_ITER = 2;      // 每帧松弛迭代次数
const COLLIDE_STIFF = 0.5;   // 单次迭代解开重叠的比例（0~1，越大越快但易抖）
// 半邻居枚举：自身格(j>i) + 右/右下/下/左下，保证每对相邻只处理一次
const COLLIDE_OFFS = [
  [0, 0], [1, 0], [1, -1], [0, -1], [-1, -1],
];
// 密度统计半径倍数：以略大于碰撞半径的邻域计近邻数（碰撞后颗粒基本不重叠，
// 直接数"重叠"会漏掉紧贴的邻居；放大到 ~1.8× 才能捕捉到堆积密度）
const COLLIDE_DENS_MULT = 1.8;

// --- CPU 路径性能优化：波场粗网格缓存 ---
// 实现已抽到 src/field-grid.js，物理与渲染共用同一份网格（每帧只构建一次）。
import {
  buildFieldGrid as _buildFieldGrid,
  sampleHeight as _sampleHeight,
  sampleGrad as _sampleGrad,
  gradOut as _gradOut,
} from "./field-grid.js";


export class ParticleSystem {
  constructor(
    numParticles = 10000,
  ) {
    this.num = numParticles;
    this.particles = [];
    // 离屏累计缓冲交给 Renderer 管理，这里只存粒子状态
    this._scratch = null;

    // 碰撞用均匀网格：cell 取最大可能半径的 2 倍，邻居只需查 3×3
    this._cell = COLLIDE_R * 1.45 * 2;
    this._cols = Math.max(
      1,
      Math.ceil(
        2 /
          this._cell,
      ),
    );
    const cells =
      this._cols *
      this._cols;
    this._buckets = new Array(
      cells,
    );
    for (
      let k = 0;
      k < cells;
      k++
    )
      this._buckets[k] = [];
  }

  // 重新生成所有粒子
  reset() {
    this.particles = [];
    for (
      let i = 0;
      i <
      this.num;
      i++
    ) {
      this.particles.push(
        this._spawn(
          {},
        ),
      );
    }
  }

  // 改变沙粒总数（重建粒子数组）
  setCount(
    numParticles,
  ) {
    this.num = Math.max(
      1,
      Math.floor(
        numParticles,
      ),
    );
    this.reset();
  }

  // 单个粒子重生：坐标 [-1,1]，初始随机小跳，沉降度 0
  _spawn(
    p = {},
  ) {
    p.x =
      (Math.random() *
        2 -
        1) *
      0.98;
    p.y =
      (Math.random() *
        2 -
        1) *
      0.98;
    // vx/vy 仅在腾空期间非零（渲染端用速度调制亮度/拖尾）
    p.vx = 0;
    p.vy = 0;
    // 腾空剩余时间（秒）；>0 表示正在一次小跳跃中
    p.air =
      Math.random() *
      0.12;
    p.airTotal = p.air;
    p.settled = 0;
    p.brightness =
      0.68 +
      Math.random() *
        0.32;
    p.size =
      0.7 +
      Math.random() *
        1.1;
    // 每颗沙粒的静摩擦个体差异（有的容易被抖起，有的顽固）
    p.grip =
      0.7 +
      Math.random() *
        0.6;
    // 统一沙粒大小：不再随机粒径（旧 0.55~1.45），全部 sizeF=1.0，
    // 保证 CPU 回退路径下所有沙粒视觉尺寸一致。
    p.sizeF = 1.0;
    // 质量 ∝ 体积 ∝ 直径³：统一直径 → mass=1，运动/碰撞一致。
    p.mass = 1.0;
    // 堆叠密度：每帧由碰撞阶段重新统计近邻数（0 = 孤立）
    p.density = 0;
    return p;
  }

  // 每帧物理更新（跳-停状态机）
  update(
    dt,
    field,
    collision,
  ) {
    const dtClamped =
      Math.min(
        dt,
        0.05,
      );
    const plateLimit =
      field.plateLimit ||
      0.97;
    const vib =
      field.vibration ||
      0;
    const kick =
      field.kick || 0;
    const treble =
      field.treble ||
      0;
    // 振动频率节律因子（硬度↑→跳动更频繁，体现"底板震动频率"）
    const vibRate =
      field.vibRate ||
      1;

    // 每帧预计算波场粗网格（见文件顶部 _buildFieldGrid）：把逐粒 trig 换成网格采样
    _buildFieldGrid(
      field,
    );

    for (
      let i = 0;
      i <
      this.particles.length;
      i++
    ) {
      const p =
        this.particles[
          i
        ];

      // ---------- 腾空阶段：弹道小跳跃 ----------
      if (
        p.air > 0
      ) {
        // 抛物线式减速：起跳初速快、落地前变慢，像被板面弹起后回落
        const airTotal =
          p.airTotal ||
          p.air;
        const phase =
          airTotal > 0
            ? p.air /
              airTotal
            : 0; // 1(起跳) → 0(落地)
        const ease =
          0.35 +
          0.65 *
            phase;
        p.x +=
          p.vx *
          dtClamped *
          ease;
        p.y +=
          p.vy *
          dtClamped *
          ease;
        p.air -=
          dtClamped;
        if (
          p.air <=
          0
        ) {
          // 落地即停：沙粒与板面摩擦大，几乎不滑行
          p.air = 0;
          p.vx = 0;
          p.vy = 0;
        }
        // 越界则在板内重生
        if (
          p.x <
            -plateLimit ||
          p.x >
            plateLimit ||
          p.y <
            -plateLimit ||
          p.y >
            plateLimit
        ) {
          this._spawn(
            p,
          );
        }
        continue;
      }

      // ---------- 着板阶段：局部震感决定是否被抛起 ----------
      // 粒子坐标 [-1,1] → [0,1]（克拉尼方程域）
      const u =
        (p.x +
          1) *
        0.5;
      const v =
        (p.y +
          1) *
        0.5;
      const psi =
        _sampleHeight(
          u,
          v,
        );
      const height =
        Math.abs(
          psi,
        );

      // 中心激振包络：震源在板心 → 板心驱动最强，向四周传播衰减
      const exc =
        field.excAt
          ? field.excAt(
              u,
              v,
            )
          : 1;

      // 局部震感：波腹（|ψ| 大）晃得凶，节线（|ψ|≈0）纹丝不动；
      // 再乘边缘激振包络（kick 是模式切换的全板踢散，不随位置衰减）
      const shake =
        height *
          (0.4 +
            vib *
              1.5 +
            treble *
              0.6) *
          exc +
        kick *
          0.9;

      // 个体质量效应：质量越大惯性越大 → 越难被抛起、抛速越低、弹起越低
      //   inertia 用于阈值/抛起频率（强耦合）；speedScale/airScale 用于速度/滞空（弱耦合）
      const inertia =
        Math.sqrt(
          p.mass,
        ); // ∝ 直径^1.5
      const speedScale =
        Math.pow(
          p.mass,
          -0.4,
        );
      const airScale =
        Math.pow(
          p.mass,
          -0.2,
        );

      // 静摩擦阈值：沉降越深越难被再次扰动；重颗粒阈值更高（更难抖起）。
      // 阈值抬高 → 节线周围更宽的"静区"，沙粒一踏进就不再被抛起，从而真正聚集。
      const threshold =
        (0.12 +
          p.settled *
            0.18) *
        p.grip *
        inertia;

      if (
        shake >
        threshold
      ) {
        // 超过静摩擦 → 按概率被板面抛起（震感越强越频繁；重颗粒抛起概率更低）
        const tossProb =
          (shake -
            threshold) *
          18 *
          vibRate *
          dtClamped /
          inertia;
        if (
          Math.random() <
          tossProb
        ) {
          // 抛射方向：以"随机各向同性"为主（板把沙粒弹起，落点随机），
          // 叠加一个朝节线的弱偏置（加速向节点收敛）。
          // 关键：即使梯度为 0（波腹中心 ∇|ψ|=0），也必须给随机方向，
          // 否则波腹沙粒永远弹不出去 → 残留在波腹，分布失真。
          _sampleGrad(
            u,
            v,
          );
          let gx = -_gradOut.x;
          let gy = -_gradOut.y;
          const glen =
            Math.sqrt(
              gx *
                gx +
                gy *
                  gy,
            );
          // 下坡单位向量；梯度越小（越靠近波腹中心 ∇|ψ|≈0）随机性越强，
          // 确保波腹沙粒能弹出去（否则会卡在波腹）。
          let dx = 0;
          let dy = 0;
          let rx = 0;
          let ry = 0;
          const ra =
            Math.random() *
            Math.PI *
            2;
          rx =
            Math.cos(
              ra,
            );
          ry =
            Math.sin(
              ra,
            );
          if (
            glen >
            1e-4
          ) {
            dx =
              gx /
              glen;
            dy =
              gy /
              glen;
          }
          // 权重：梯度大→强下坡（收敛到节线，图案利落）；梯度小→强随机（逃出波腹）
          const wDown =
            Math.min(
              1,
              glen *
                0.25,
            );
          let mx =
            dx *
              wDown +
            rx *
              (1 -
                wDown);
          let my =
            dy *
              wDown +
            ry *
              (1 -
                wDown);
          const mlen =
            Math.sqrt(
              mx *
                mx +
                my *
                  my,
            ) ||
            1;
          mx /=
            mlen;
          my /=
            mlen;
          // 后期增强增益：放大抛速与弹起高度（增益越大，沙粒弹得越高越远）
          const motionGain =
            field.motionGain ||
            1;
          // 抛速：水平步长刻意压小，使沙粒能"踏进"节线带而非一跳跨过
          //（否则会在节线两侧来回震荡、永远聚不到线上）。重颗粒更慢（a = F/m）。
          const speed =
            Math.min(
              3.0,
              0.6 *
                motionGain,
              (0.06 +
                Math.min(
                  shake,
                  2,
                ) *
                  0.2 +
                kick *
                  0.25) *
                speedScale *
                motionGain,
            ) *
            (0.7 +
              Math.random() *
                0.6);
          // 弹起高度/滞空：轻颗粒抛得高、滞空久；重颗粒贴板、低跳。
          //   滞空 ∝ 1/√质量（抛高 ∝ v² ∝ 1/m，滞空 ∝ √高）；水平位移随之受限，
          //   保证沙粒小步聚拢到节线而非大跳跨过。后期增益按 √ 放大滞空。
          const airTime =
            (0.03 +
              Math.random() *
                0.04) *
            airScale *
            Math.sqrt(
              motionGain,
            );
          p.vx =
            mx *
            speed;
          p.vy =
            my *
            speed;
          p.air =
            airTime;
          p.airTotal =
            airTime;
          // 被抛起即失去沉降
          p.settled =
            Math.max(
              p.settled -
                0.5,
              0,
            );
          continue;
        }
      }

      // ---------- 静止在板上：贴近节线（|ψ| 小）则逐渐沉降 ----------
      // 直接用高度阈值判定，比 exp 亲和度更稳：节线带稍放宽，捕获更可靠
      if (
        height <
        0.18
      ) {
        p.settled =
          Math.min(
            p.settled +
              dtClamped *
                0.9,
            1,
          );
      } else {
        p.settled =
          Math.max(
            p.settled -
              dtClamped *
                1.5,
            0,
          );
      }
    }

    // 颗粒间短程斥力：解开重叠，使沙粒不能占同一点（节线处堆成有宽度的沙带）。
    // collision=false（默认）时整段跳过：去掉碰撞——沙粒沿节线收成细脊（更接近真实克拉尼图形），
    // 并重置 density，避免沿用上一帧的陈旧堆积密度（渲染端依赖它做高光/不透明）。
    if (
      collision
    ) {
      this._resolveCollisions();
    } else {
      const ps = this.particles;
      for (
        let i = 0;
        i < ps.length;
        i++
      ) {
        ps[i].density = 0;
      }
    }
  }

  // 颗粒间短程斥力（空间网格 + 位置修正）：沙粒不可重叠，节线处自然堆成有宽度的沙带。
  // 仅做位置修正、不引入速度，避免与现有"抛起/沉降"状态机冲突。
  _resolveCollisions() {
    const cols =
      this._cols;
    const cell =
      this._cell;
    const buckets =
      this._buckets;
    const ps =
      this.particles;
    const n =
      ps.length;
    // 清空桶（复用数组，避免每帧分配）
    for (
      let k = 0;
      k < buckets.length;
      k++
    )
      buckets[k].length = 0;
    // 入桶：坐标 [-1,1] → 网格下标（越界夹回，防止极端弹跳溢出）
      for (
        let i = 0;
        i < n;
        i++
      ) {
        const p =
          ps[i];
        p.density = 0;
        let gx = ((
        p.x +
        1
      ) /
        cell) |
        0;
      let gy = ((
        p.y +
        1
      ) /
        cell) |
        0;
      if (
        gx < 0
      )
        gx = 0;
      else if (
        gx >= cols
      )
        gx = cols - 1;
      if (
        gy < 0
      )
        gy = 0;
      else if (
        gy >= cols
      )
        gy = cols - 1;
      buckets[
        gy *
          cols +
        gx
      ].push(
        i,
      );
    }
    // 松弛迭代：每轮解开一部分重叠，多次迭代收敛更稳
    for (
      let it = 0;
      it < COLLIDE_ITER;
      it++
    ) {
      for (
        let gy = 0;
        gy < cols;
        gy++
      ) {
        for (
          let gx = 0;
          gx < cols;
          gx++
        ) {
          const cellArr =
            buckets[
              gy *
                cols +
              gx
            ];
          if (
            cellArr.length ===
            0
          )
            continue;
          for (
            let o = 0;
            o < COLLIDE_OFFS.length;
            o++
          ) {
            const nx =
              gx +
              COLLIDE_OFFS[o][0];
            const ny =
              gy +
              COLLIDE_OFFS[o][1];
            if (
              nx < 0 ||
              nx >= cols ||
              ny < 0 ||
              ny >= cols
            )
              continue;
            const nbr =
              buckets[
                ny *
                  cols +
                nx
              ];
            if (
              nbr.length ===
              0
            )
              continue;
            const sameCell =
              COLLIDE_OFFS[o][0] ===
                0 &&
              COLLIDE_OFFS[o][1] ===
                0;
            for (
              let a = 0;
              a < cellArr.length;
              a++
            ) {
              const i =
                cellArr[a];
              const pi =
                ps[i];
              const ri =
                COLLIDE_R *
                pi.sizeF;
              for (
                let b = 0;
                b < nbr.length;
                b++
              ) {
                const j =
                  nbr[b];
                if (
                  sameCell &&
                  j <= i
                )
                  continue;
                const pj =
                  ps[j];
                const rj =
                  COLLIDE_R *
                  pj.sizeF;
                let dx =
                  pi.x -
                  pj.x;
                let dy =
                  pi.y -
                  pj.y;
                const minD =
                  ri + rj;
                const d2 =
                  dx *
                    dx +
                  dy *
                    dy;
                if (
                  d2 >=
                    minD *
                      minD ||
                  d2 < 1e-12
                )
                  continue;
                const d =
                  Math.sqrt(
                    d2,
                  );
                const overlap =
                  minD - d;
                // 按质量反比分配位移：重的动得少，轻的被挤开更多
                const invI =
                  1 /
                  pi.mass;
                const invJ =
                  1 /
                  pj.mass;
                const invSum =
                  invI +
                  invJ;
                const corr =
                  overlap *
                  COLLIDE_STIFF;
                const wx =
                  invI /
                  invSum;
                const wy =
                  invJ /
                  invSum;
                const ux =
                  dx / d;
                const uy =
                  dy / d;
                pi.x +=
                  ux *
                  corr *
                  wx;
                pi.y +=
                  uy *
                  corr *
                  wx;
                pj.x -=
                  ux *
                  corr *
                  wy;
                pj.y -=
                  uy *
                  corr *
                  wy;
              }
            }
          }
        }
      }
    }
    // 堆叠密度统计：在碰撞半径的略大邻域内数近邻数（每对只数一次），
    // 作为"堆积密度"指标交给渲染端，使密集堆积的沙粒更亮、更大、更实，强化沙堆观感。
    // 碰撞后颗粒基本不重叠，直接数"重叠"会漏掉紧贴的邻居；
    // 故把统计半径放大到 ~COLLIDE_DENS_MULT×，才能捕捉到真实的堆积密度。
    const densR =
      COLLIDE_R *
      COLLIDE_DENS_MULT;
    for (
      let gy = 0;
      gy < cols;
      gy++
    ) {
      for (
        let gx = 0;
        gx < cols;
        gx++
      ) {
        const cellArr =
          buckets[
            gy *
              cols +
            gx
          ];
        if (
          cellArr.length ===
          0
        )
          continue;
        for (
          let o = 0;
          o < COLLIDE_OFFS.length;
          o++
        ) {
          const nx =
            gx +
            COLLIDE_OFFS[o][0];
          const ny =
            gy +
            COLLIDE_OFFS[o][1];
          if (
            nx < 0 ||
            nx >= cols ||
            ny < 0 ||
            ny >= cols
          )
            continue;
          const nbr =
            buckets[
              ny *
                cols +
              nx
            ];
          if (
            nbr.length ===
            0
          )
            continue;
          const sameCell =
            COLLIDE_OFFS[o][0] ===
              0 &&
            COLLIDE_OFFS[o][1] ===
              0;
          for (
            let a = 0;
            a < cellArr.length;
            a++
          ) {
            const i =
              cellArr[a];
            const pi =
              ps[i];
            const ri =
              densR *
              pi.sizeF;
            for (
              let b = 0;
              b < nbr.length;
              b++
            ) {
              const j =
                nbr[b];
              if (
                sameCell &&
                j <= i
              )
                continue;
              const pj =
                ps[j];
              const rj =
                densR *
                pj.sizeF;
              const dx =
                pi.x -
                pj.x;
              const dy =
                pi.y -
                pj.y;
              const minD =
                ri + rj;
              const d2 =
                dx *
                  dx +
                dy *
                  dy;
              if (
                d2 >=
                  minD *
                    minD
              )
                continue;
              pi.density +=
                1;
              pj.density +=
                1;
            }
          }
        }
      }
    }
    // 夹回坐标域，避免斥力把沙粒推出 [-1,1]
    for (
      let i = 0;
      i < n;
      i++
    ) {
      const p =
        ps[i];
      if (
        p.x < -1
      )
        p.x = -1;
      else if (
        p.x > 1
      )
        p.x = 1;
      if (
        p.y < -1
      )
        p.y = -1;
      else if (
        p.y > 1
      )
        p.y = 1;
    }
  }
}

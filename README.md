# 珊瑚礁样带结构复杂度评估系统

用多视角浅水照片自动评估礁体表面结构复杂度，替代人工拉链（一条样带一下午 → 秒级）。
TypeScript + WebGL2 实现，无第三方运行时依赖。

## 核心管线

```
原图
 ├─ 1. 光照/反照分层（梯度域 Horn Retinex，对数域 Poisson 求解 + White-Patch p99 锚定）
 │     · 小梯度归光照（阴影缓变、环境光），大梯度让给反照（深色珊瑚边界、沙沟）
 │     · 大片深色珊瑚因边界梯度被划给反照，光照保持平滑 → 不会被后续 SFS 误判成凹坑
 ├─ 2. 焦散剥离：正残差（MAD 鲁棒阈值）+ 低饱和联合检出，邻域修复
 ├─ 3. 阴影掩膜：相对光照中位数自适应阈值，阴影区在 SFS 中降权扩散
 ├─ 4. 多尺度 Horn 明暗恢复（SFS）：朗伯辐照度 → 表面梯度 → Jacobi/Poisson 积分高度场
 └─ 5. 离散链测法：2cm 链节沿高度场求交，输出每平方米粗糙度 R = 链长 / 水平距离
```

关键正确性设计：
- **深色珊瑚 vs 凹坑**：Retinex 把暗反照与暗光照分离，SFS 只吃去焦散、去反照的光照层；阴影降权（`shadowWeight=0.08`）+ 坡度钳制防坑化。
- **GPU/CPU 同数学**：`src/core` 是 CPU 参考实现（Vitest 验证），`src/glsl` + `src/webgl` 是同公式的 WebGL2 实现。

## 目录

```
src/
  core/      算法 CPU 参考实现：retinex / decomp / sfs / geometry(链测) / viz / runner
  glsl/      WebGL2 着色器（与 core 逐 pass 对应）
  webgl/     GPU 管线、浮点纹理/FBO 封装、上下文丢失恢复
  synth/     测试图合成：4 种礁体模型 + 程序化焦散(Voronoi) + 高度场投射阴影
  ui/        列表页 / 测试页 / 详情页(分层+起伏叠加) / 统计页(年际变化)
  state/     IndexedDB 持久化（样带、照片 Blob、评估结果）
tests/       Vitest 真值对照测试（14 项）
scripts/     headless-bench.mjs（GPU 验收）、smoke-ui.mjs（UI 冒烟）
```

## 命令

```bash
npm run dev      # 开发服务器
npm test         # CPU 算法真值对照（14 项，含 4 模型 ≤10% 误差门限）
npm run bench    # headless Chrome GPU 验收（误差 + 24MP 性能门限）
npm run smoke    # 三个路由的 UI 冒烟测试
npm run build    # 类型检查 + 生产构建
```

## 验收结果（AMD Radeon 780M / ANGLE D3D11，headless Chrome）

| 用例 | 真值 R | 测得 R | 误差 | 门限 10% |
|---|---|---|---|---|
| 块状 massive | 1.046 | 1.003 | 4.14% | ✓ |
| 枝状 branching | 1.118 | 1.011 | 9.52% | ✓ |
| 混合 mixed | 1.085 | 1.012 | 6.75% | ✓ |
| 平坦 flat | 1.000 | 1.000 | 0.00% | ✓ |
| **24MP（6000×4000）** | 1.090 | 1.010 | 7.31% | ✓ 处理 **~1.7s ≤ 4s** |

CPU 参考实现同口径误差 ≤ 1.7%（单元测试）。

## 已知工程细节

- 浮点渲染目标统一用 `RGBA16F`（单通道 ANGLE/D3D11 可渲染性差），高度场读 `.r`。
- 每个 pass 前清空所有纹理采样单元，避免上一 pass 渲染目标残留形成反馈循环（`INVALID_OPERATION`）。
- SFS 用三缓冲轮转保证 Jacobi 读写纹理不同；每用例独立浏览器进程隔离 headless GPU 驱动状态。
- WebGL 上下文丢失（`webglcontextlost`）自动重建；GPU 失败自动回退 CPU 路径。

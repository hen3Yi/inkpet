// 顶点为 Live2D unit 坐标；枢轴和 headDy 为角色画布像素。
// 身体绕胯部缩放，头保持尺寸、跟随颈根平移，最后加上头部下移。
export function transformProportions(vertices, { sx, sy, headDy, head, pivot, neck, ppu, ox, oy }) {
  const dx = (neck.x - pivot.x) * (sx - 1);
  const dy = (neck.y - pivot.y) * (sy - 1) + headDy;
  for (let k = 0; k < vertices.length; k += 2) {
    const x = ox + vertices[k] * ppu;
    const y = oy - vertices[k + 1] * ppu;
    const nx = head ? x + dx : pivot.x + (x - pivot.x) * sx;
    const ny = head ? y + dy : pivot.y + (y - pivot.y) * sy;
    vertices[k] = (nx - ox) / ppu;
    vertices[k + 1] = (oy - ny) / ppu;
  }
}

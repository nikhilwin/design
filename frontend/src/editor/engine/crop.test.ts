import { type CropGeometry, clampCrop, cropToFrame, fitAspect, frameToCrop } from './crop'

const base: CropGeometry = { natW: 400, natH: 200, sx: 0.5, sy: 0.5, angle: 0, flipX: false, flipY: false, ghostCenter: { x: 300, y: 200 } }

describe('crop geometry', () => {
  it('a full-image crop maps to a frame the size of the scaled image, centred on the ghost', () => {
    const f = cropToFrame(base, { cropX: 0, cropY: 0, width: 400, height: 200 })
    expect(f).toEqual({ cx: 300, cy: 200, w: 200, h: 100 })
  })

  it('frameToCrop inverts cropToFrame for arbitrary rotation and flips', () => {
    for (const angle of [0, 30, 90, 217]) {
      for (const flipX of [false, true]) {
        for (const flipY of [false, true]) {
          const g = { ...base, angle, flipX, flipY }
          const c = { cropX: 40, cropY: 25, width: 180, height: 90 }
          const back = frameToCrop(g, cropToFrame(g, c))
          expect(back.cropX).toBeCloseTo(c.cropX, 6)
          expect(back.cropY).toBeCloseTo(c.cropY, 6)
          expect(back.width).toBeCloseTo(c.width, 6)
          expect(back.height).toBeCloseTo(c.height, 6)
        }
      }
    }
  })

  it('moving the frame right moves the crop window right (and left when flipped)', () => {
    const c = { cropX: 100, cropY: 50, width: 100, height: 100 }
    const f = cropToFrame(base, c)
    expect(frameToCrop(base, { ...f, cx: f.cx + 20 }).cropX).toBeCloseTo(140)
    const flipped = { ...base, flipX: true }
    const ff = cropToFrame(flipped, c)
    expect(frameToCrop(flipped, { ...ff, cx: ff.cx + 20 }).cropX).toBeCloseTo(60)
  })

  it('moving along a rotated axis uses the image axes', () => {
    const g = { ...base, angle: 90 }
    const c = { cropX: 100, cropY: 50, width: 100, height: 100 }
    const f = cropToFrame(g, c)
    // At 90° the image x axis points down the screen.
    expect(frameToCrop(g, { ...f, cy: f.cy + 10 }).cropX).toBeCloseTo(120)
  })

  it('clamps to the image bounds and size', () => {
    expect(clampCrop(base, { cropX: -50, cropY: 190, width: 100, height: 50 })).toEqual({ cropX: 0, cropY: 150, width: 100, height: 50 })
    expect(clampCrop(base, { cropX: 0, cropY: 0, width: 9999, height: 9999 })).toMatchObject({ width: 400, height: 200 })
    expect(clampCrop(base, { cropX: 0, cropY: 0, width: 0, height: 0 }).width).toBe(8)
  })

  it('fits an aspect ratio inside the image around the current centre', () => {
    const full = { cropX: 0, cropY: 0, width: 400, height: 200 }
    const sq = fitAspect(base, full, 1)
    expect(sq.width / sq.height).toBeCloseTo(1)
    expect(sq.height).toBeCloseTo(200)
    expect(sq.cropX).toBeCloseTo(100)
    const wide = fitAspect(base, { cropX: 100, cropY: 50, width: 100, height: 100 }, 2)
    expect(wide.width / wide.height).toBeCloseTo(2)
    expect(wide.cropX).toBeGreaterThanOrEqual(0)
    expect(wide.cropX + wide.width).toBeLessThanOrEqual(400)
  })

  it('accounts for non-uniform scale when matching the visual aspect', () => {
    const g = { ...base, sx: 1, sy: 0.5 }
    const c = fitAspect(g, { cropX: 0, cropY: 0, width: 400, height: 200 }, 1)
    expect((c.width * g.sx) / (c.height * g.sy)).toBeCloseTo(1)
  })
})

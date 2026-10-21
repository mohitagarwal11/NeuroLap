# Future 3D Driving Camera Plan

## Goal

Add a forward-facing, perspective-style camera while the player is driving.
Keep the track editor, simulation, and collision rules in their existing
top-down 2D form.

## Recommended First Version: Pseudo-3D

Use the existing canvas renderer to create a classic racing-game view rather
than moving immediately to a full 3D engine. The current 2D physics remains
the source of truth for car movement and wall collisions.

The driving view would:

- Read a short run of upcoming centerline samples from `Track`.
- Convert those points from car-relative world space into screen-space
  perspective, with distant road sections approaching a horizon line.
- Draw the road surface, white edge markings, dashed center line, infield,
  and finish line in the perspective view.
- Keep the car near the bottom of the screen and retain the current HUD,
  controls, lap timing, crashes, and restart behavior.
- Continue using the top-down view for drawing and previewing a new track.

## Implementation Outline

1. Add a read-only `Track` API that returns centerline samples ahead of the
   car, including their distance along the loop and road width.
2. Create a driving-camera renderer that projects those samples relative to
   the car's position and heading.
3. Render the pseudo-3D view only for `DRIVING` and `CRASHED`; retain the
   existing top-down renderer for `DRAWING` and `READY`.
4. Tune the horizon height, draw distance, field of view, road colors, and
   marking sizes for readability at different speeds and screen sizes.
5. Test tight turns, the start/finish join, reverse driving, crashes, window
   resize, keyboard input, and gamepad input.

## Estimated Effort

- **Pseudo-3D first version:** about 1–2 focused development days.
- **Polished pseudo-3D:** extra time for camera smoothing, roadside props,
  visual effects, and device performance testing.
- **True 3D/WebGL version:** roughly 4–8+ days for an initial quality build;
  it would require track-mesh generation, a 3D camera, materials/lighting,
  car visuals, and additional rendering/performance work.

## Possible Later Enhancements

- Camera smoothing and speed-based field of view.
- Roadside trees, barriers, signs, and shadows.
- Elevation and banking data for tracks.
- Car sprites or a 3D car model.
- A future Three.js/WebGL renderer if true 3D is needed.

## Non-Goals for the First Version

- Replacing the existing 2D physics or collision system.
- Rebuilding the track editor in 3D.
- Adding a WebGL dependency solely for the initial camera view.

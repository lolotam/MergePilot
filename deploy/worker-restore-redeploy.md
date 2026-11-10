# Worker restore redeploy — 2026-11-10

The review worker on musalam-2 has been stopped since migration 0020 (#199) and the
release hold (#200) blocked every release after it. PR #202 added the `single_phase`
manual release option, but it changed only release plumbing — no image-building path —
so the gated release skips it ("nothing new to deploy").

The application code on main is unchanged by #202, but production still needs a fresh
deploy so web and the worker come up together on one image. This file touches
`deploy/**`, which makes the Docker Image workflow build an image for the merge commit;
the manual `single_phase=true` Release run then deploys web and worker in one phase.

This commit intentionally changes no application behavior.

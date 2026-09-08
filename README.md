# Ditto

A WebGPU soft-body toy. The Pokémon X/Y Ditto mesh is driven by a tetrahedral
physics cage generated from the model itself, so you can grab him, stretch him
and throw him. The field around him is HD-2D: pixel tuft sprites that turn to
the camera, flatten under his weight and spring back a few seconds after he
walks on.

**[jeramai.github.io/ditto](https://jeramai.github.io/ditto/)** · try
[`?shiny`](https://jeramai.github.io/ditto/?shiny) · `?hud=1` shows the frame
and solver readout.

Wander with WASD. Tap space to hop, or stand still and hold it — he squishes,
and the deeper the squish the higher he goes. Drag him to stretch him, drag the
field to orbit. Turning the sound on starts something.

This is our own engine: the solver, the skinning, the world and the interface
are all ours, on top of three.js. Nothing of the toy that inspired it remains.

## Credits

Ditto is a Pokémon, owned by Nintendo, Creatures and Game Freak. The dancing
sprite and the idea of setting it to a conga come from
[matias.me/nsfw](https://matias.me/nsfw/), and the track is "Conga" by Gloria
Estefan and Miami Sound Machine.

# The display ships in the plugin, with Helix as one of its sources

The display's page, scripts and view (once `helix/ui/`) move into the
plugin, so `animus ui` can show the jobs a laptop runs itself from
`~/.animus`, beside Helix serving the same pages from `helix.db`. Each
source answers the same shape the page reads; the page does not know which
it talks to. This is the one exception to "Helix is never shipped in the
plugin": only the display moves, and nothing that supervises jobs comes with
it. A second copy of the page for laptops, or running `helix serve` locally,
was turned down: two pages drift apart, and a Helix on a laptop would bring
a queue, containers and tokens that a person running their own jobs does
not need.

# To do

Ideas parked for later. Each needs its own plan before any code.

## "Leave now" alerts

A bus alert that accounts for the walk to the stop: pick a stop, a line and
where you start from, and get "Leave now: the 70 arrives in 9 min, 7 min walk"
when the next bus minus the walking time gets down to about two minutes.

Most of the plumbing exists: the shared `StopPoller` boards, the per-user
`TrackingRunner` rules and push, and the planner's walking times. What it
needs is the rule, a small setup UI, and finer timing than the 2-minute board
while a "leave now" window is open.

## Bike dock analysis

Parked: too big to start without a proper plan, and its use beyond curiosity
is not established yet. Decide what question it answers first.

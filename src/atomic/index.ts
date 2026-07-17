// Atomic sub-dust LN swap — protocol core (ATOMIC_SUBDUST_PLAN.md §4).
// Phase 1 lands the pure logic here; the tx builder / presign (#05) and the
// state machine (#06) build on top. The bridge is the source of truth for this
// module; the boltz patch vendors a copy (§8 [#03]).
export * from './script'
export * from './params'
export * from './split'
export * from './eligibility'
export * from './tx'
export * from './state'
export * from './repository'

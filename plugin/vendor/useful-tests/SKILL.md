---
name: useful-tests
description: Rules for writing tests that earn their keep — load before writing or generating any tests, during implementation, TDD, or when asked to "add tests". Prevents redundant, mock-only, implementation-coupled, and framework-testing tests from being written in the first place.
---

# Useful tests

Default is to write **fewer** tests than feels natural. A test costs maintenance forever; it must buy something.

## Before writing any test, write its justification

For each test, state in one line (in your head or as a comment above it):

> Protects: <behavior or contract>. Fails when: <the bug>.

If you cannot fill in "Fails when" with a bug someone would actually ship, do not write the test.

## Budget per unit of behavior

For each public function, endpoint, or component behavior:

- **1** happy-path test (not one per input variation — pick the representative case)
- **1** test per meaningful boundary the code branches on (empty, single, many, limit, null/absent, invalid type, unicode, concurrent — only the ones the code actually handles)
- **1** test per error/exception path
- **1** regression test per fixed bug, named with the issue ID

If several cases share the same assertion shape, write **one table-driven / parametrized test**, not siblings.

Anything beyond this budget needs a stated reason.

## Assert on outcomes, not mechanics

- Assert return values, resulting state, emitted events, persisted data, or user-visible output.
- Do **not** assert that a private method was called, the order of internal calls, or the shape of internal data structures.
- A mock's `called_with` is never the only assertion. If the only way to observe the behavior is "the mock was called", the test is testing wiring — either raise the level (integration test against a fake/in-memory impl) or skip it.
- Prefer fakes and in-memory implementations over mocks for collaborators. Mocks are for things that are slow, nondeterministic, or external (network, clock, randomness, filesystem).

## Do not write tests for

- Getters, setters, constructors, dataclass field presence
- The framework, ORM, serializer, router, or standard library
- Logging output
- Type signatures (that's the type checker's job)
- Pure pass-through / delegation functions with no logic
- Every enum value when the code doesn't branch per value
- "Returns None/throws when given None" for parameters that can't be None at the call site
- Snapshots nobody will review on change

## Naming and shape

- Name describes the behavior and condition: `rejects_expired_token`, `returns_empty_list_when_no_matches` — not `test_function_name_2`.
- One concept per test. If the name needs "and", split or parametrize.
- Arrange / act / assert, visibly. No logic in tests (loops, conditionals, try/except) except in the parametrization table.
- Don't compute the expected value with the code under test. Hard-code it.

## When the code is hard to test

Do not pile on mocks to force a unit test. Say the code is hard to test and either (a) write an integration test at the level where behavior is observable, or (b) propose a small refactor (inject the dependency, extract the pure core). Pick (b) only if the user is doing implementation work now.

## Before finishing

Re-read the tests you wrote against these rules. Delete anything you can't justify in one line.

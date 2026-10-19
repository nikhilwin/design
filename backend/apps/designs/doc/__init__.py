"""Server-side toolkit for `DoryDocument`s: build objects the editor accepts, edit documents, summarise them.

Everything here is a pure function of plain JSON (no Fabric, no browser). The builders mirror the editor's own
factories (`frontend/src/editor/engine/objects/factories.ts`); the contract tests in
`apps/designs/tests/test_doc_toolkit.py` and the frontend test `backendBuilders.test.ts` keep the two in step.
"""

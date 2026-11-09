# Local context screening

The server is authoritative. Local checks cannot replace its sanitizer and two
independent validators. Client checked flags never confer approval.

Set `RESTLESS_CONTEXT_EXTRACTION_MODEL` and `RESTLESS_CONTEXT_REVIEW_MODEL` to
different supported full identities: `claude-haiku-5-5`, `claude-sonnet-5-5` or
`claude-opus-5-5`. Verify account entitlement before use. There are no defaults.
Context currently requires the selected Claude provider. Codex context fails closed
until its tool-free, pinned-model review contract is supported. Other commands do
not change providers. The CLI never silently sends candidates to another processor.

The local scanner checks all uploaded candidate text, including provenance paths,
and decodes percent/base64 forms for extra checks. Review sees candidates only,
uses a different model, has no tools, disables session persistence and payload debug
logs, and requires complete unique verdicts. It cannot inspect the repository.
Existing selected-agent processing terms still apply. Local execution does not
mean the selected model runs offline. Confirm retention and consent for that agent.

Candidates withheld locally never enter the upload. A failed local review uploads
nothing. A server infrastructure failure returns an error and retains the previous
watermark so the next run can retry. Model checks are fallible, not a guarantee
against leaks.

## Coordinated release

CLI 0.13.0 supports resumable knowledge screening and declares
`restless.knowledgeResumeProtocol: 1` in its npm manifest. Release it to the npm
`latest` tag before the coordinated server deployment. Production builds verify
the published version and capability. A checkout or packed tarball is not a release.

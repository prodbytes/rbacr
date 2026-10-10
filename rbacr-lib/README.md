# rbacr-lib

A client library for [rbacr](../README.md): applications use it to ask the
rbacr service ([rbacr-sls](../rbacr-sls/README.md)) which roles their users
hold, and it caches the role grants so that not every check is a request.

**Status:** not specified or implemented yet. The specification will come
first; until then this folder holds only this README.

The service side it will talk to is already defined in
[rbacr-sls/SPEC.md](../rbacr-sls/SPEC.md): the external API (`/api`, personal
API tokens) and the client integration rules (C1-C6), including how fresh
answers are and what clients should cache, and the system status (R12) that tells a
system in maintenance (R11) from a missing role.

Like [rbacr-flutter](../rbacr-flutter/README.md), it will take its base URL
and token from `RBACR_URL` and `RBACR_TOKEN` by default (SPEC C7), so it
works against the local dev server as well as production.

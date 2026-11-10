# Agent guide

Before changing the Django collection feature, read:

- `docs/django-collections.md` for the implemented API and operational contract.
- `docs/spatial-collection-architecture.md` for the longer-term architecture.

Keep generated collection tables out of Django migrations; use the documented
schema command instead.

Create or update the relevant documentation in `docs/` whenever introducing a
feature or fixing behaviour.

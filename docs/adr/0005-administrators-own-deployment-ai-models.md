# Administrators own deployment AI models

Each Workshop Deployment has one Deployment Model Catalog that all administrators manage, while
non-administrator users may select its models but cannot view or change their configuration; this
replaces per-user model credentials and accepts that provider cost, quota, and limits are shared.
Model credentials stay server-side, and conversations and application bindings keep stable model
references that resolve through the catalog for each new call so credential rotation and revocation
take effect without copying secrets. Existing personal model configurations are not migrated into
the catalog, so administrators must add the Deployment Models again after upgrade.

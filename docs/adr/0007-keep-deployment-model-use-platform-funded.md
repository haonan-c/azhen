# Keep Deployment Model use platform-funded

Every Deployment Model call uses credentials and provider funds owned by the Workshop Deployment,
and every User pays for that use through Usage Credits. We reject a user-funded AI Gateway fallback
even when it does not let the User configure the model, because two calls to the same Deployment
Model would otherwise follow different funding and billing paths and user funding could bypass the
Workshop's Usage Charge. A Cloudflare Gatekeeper may still provide capabilities unrelated to model
funding.

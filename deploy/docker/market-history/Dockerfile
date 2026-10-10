FROM public.ecr.aws/lambda/nodejs:24 AS runtime
COPY package.json package-lock.json ${LAMBDA_TASK_ROOT}/
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY index.mjs token-metadata.json base-v1-pools.json additional-pools.json ${LAMBDA_TASK_ROOT}/
CMD ["index.handler"]

FROM runtime AS proof
COPY e2e.mjs reference-e2e.mjs proof.mjs ${LAMBDA_TASK_ROOT}/
COPY fixture ${LAMBDA_TASK_ROOT}/fixture
ENTRYPOINT ["/var/lang/bin/node", "/var/task/proof.mjs"]
CMD ["/var/task/fixture", "/tmp/history-proof"]

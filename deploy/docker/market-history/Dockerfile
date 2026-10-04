# Native-runtime proof only: no scheduled worker or AWS write adapter is deployed.
FROM public.ecr.aws/lambda/nodejs:24
COPY package.json package-lock.json ${LAMBDA_TASK_ROOT}/
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY e2e.mjs ${LAMBDA_TASK_ROOT}/e2e.mjs
COPY fixture ${LAMBDA_TASK_ROOT}/fixture
ENTRYPOINT ["/var/lang/bin/node", "/var/task/e2e.mjs"]
CMD ["/var/task/fixture", "/tmp/history-proof"]

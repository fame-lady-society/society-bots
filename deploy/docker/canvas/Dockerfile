FROM public.ecr.aws/lambda/nodejs:24

# Install the dependencies

RUN npm i canvas@next

COPY index.mjs ${LAMBDA_TASK_ROOT}

ENV LD_PRELOAD=/var/task/node_modules/canvas/build/Release/libz.so.1

# RUN dnf remove -y cairo-devel libjpeg-turbo-devel \
# 	pango-devel giflib-devel zlib-devel librsvg2-devel \
# 	&& dnf clean all

CMD ["index.handler"]
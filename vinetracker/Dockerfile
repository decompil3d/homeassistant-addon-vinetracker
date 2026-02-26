ARG BUILD_FROM
FROM $BUILD_FROM

ENV LANG=C.UTF-8
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apk add --no-cache \
    nodejs \
    npm \
    git \
    sqlite

COPY package.json index.js migrate.js xlsx.js *.hbs /
RUN cd / && npm install --unsafe-perm

COPY run.sh /
RUN chmod a+x /run.sh

ENV DB_BASE_PATH=/share/

EXPOSE 8099

CMD [ "/run.sh" ]

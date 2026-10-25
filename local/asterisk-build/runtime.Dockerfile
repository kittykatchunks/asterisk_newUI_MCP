FROM scratch
LABEL org.asterisk.local.scope="isolated-fixture-not-redistribution-approved"
LABEL org.asterisk.local.bundle-manifest-sha256="52ac226cfcdb1fdae4c538a265308c284aea04c7398574b13915c5a033c4ef88"
COPY --chown=10001:10001 bundle/ /opt/asterisk/
COPY --chown=10001:10001 modules/ /opt/asterisk/modules/
ENV LD_LIBRARY_PATH=/opt/asterisk/main:/opt/asterisk/runtime-libs
ENV LOCPATH=/opt/asterisk/runtime-locale
ENV GCONV_PATH=/opt/asterisk/runtime-gconv
USER 10001:10001
WORKDIR /opt/asterisk
STOPSIGNAL SIGTERM
ENTRYPOINT ["/opt/asterisk/runtime-libs/ld-linux-x86-64.so.2", "--library-path", "/opt/asterisk/main:/opt/asterisk/runtime-libs", "/opt/asterisk/main/asterisk"]
CMD ["-C", "/fixture/asterisk.conf", "-f"]

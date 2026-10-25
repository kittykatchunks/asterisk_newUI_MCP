FROM scratch
LABEL org.asterisk.local.scope="isolated-fixture-not-redistribution-approved"
LABEL org.asterisk.local.bundle-manifest-sha256="1d83ef928916419a836e4297addc7e56c91b75a69314f2ded15035c9b859dffd"
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

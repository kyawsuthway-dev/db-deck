# Test SSH server for DB Deck's SSH tunnel. Test only: a fixed password and no hardening.
# Through it, the databases are reachable as postgres:5432 and mysql:3306.
FROM alpine:3.20
RUN apk add --no-cache openssh \
 && adduser -D -s /bin/sh dbdeck \
 && echo 'dbdeck:dbdeck' | chpasswd \
 && mkdir -p /home/dbdeck/.ssh && chmod 700 /home/dbdeck/.ssh && touch /home/dbdeck/.ssh/authorized_keys \
 && chmod 600 /home/dbdeck/.ssh/authorized_keys && chown -R dbdeck:dbdeck /home/dbdeck/.ssh \
 && printf '%s\n' 'PasswordAuthentication yes' 'PubkeyAuthentication yes' 'AllowTcpForwarding yes' \
      'PermitRootLogin no' 'AuthorizedKeysFile .ssh/authorized_keys' > /etc/ssh/sshd_config.d/dbdeck.conf
EXPOSE 22
# Host keys are generated on first start, so each container has its own (DB Deck asks you to trust it once).
CMD ["sh", "-c", "ssh-keygen -A && exec /usr/sbin/sshd -D -e"]

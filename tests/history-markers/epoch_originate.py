import configparser
import socket


config = configparser.ConfigParser()
config.read("/run/proof/manager.conf")
secret = config["epoch-proof"]["secret"]
with socket.create_connection(("127.0.0.1", 5038), timeout=10) as connection:
    connection.settimeout(15)
    stream = connection.makefile("rb")

    def action(fields):
        connection.sendall(
            ("\r\n".join(f"{key}: {value}" for key, value in fields.items()) + "\r\n\r\n").encode()
        )
        while True:
            result = {}
            while True:
                line = stream.readline()
                if not line:
                    raise RuntimeError("Epoch proof AMI connection closed")
                if line == b"\r\n":
                    break
                text = line.decode().strip()
                if ": " in text:
                    key, value = text.split(": ", 1)
                    result[key] = value
            if result.get("ActionID") == fields["ActionID"]:
                if result.get("Response") not in ("Success", "Goodbye"):
                    raise RuntimeError("Epoch proof AMI action rejected")
                return

    action({"Action": "Login", "ActionID": "login", "Username": "epoch-proof", "Secret": secret, "Events": "off"})
    action({
        "Action": "Originate", "ActionID": "originate",
        "Channel": "Local/entry@history-epoch/n",
        "Application": "Wait", "Data": "4", "Timeout": "10000",
        "ChannelId": "epoch-reused-originator", "OtherChannelId": "epoch-reused-caller",
    })
    action({"Action": "Logoff", "ActionID": "logoff"})
print("PASS bounded synthetic epoch call originated with explicit reused channel IDs")

import hashlib

def hash_password(pw):
    return hashlib.md5(pw.encode()).hexdigest()

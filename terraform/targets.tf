# The DAST allow-list. Users can only pick one of these ids, never send a URL.
# The real URL (var.juice_shop_url) is only given to the launcher, never to a browser.
# Lambdas read this list from the TARGETS_JSON environment variable.

locals {
  targets = [
    {
      targetId    = "juice-shop"
      name        = "OWASP Juice Shop"
      description = "Deliberately vulnerable test app"
    },
  ]
}

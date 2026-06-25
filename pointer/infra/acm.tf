# Reuse the pre-existing wildcard certificate (*.chargebee-labs.com)
# imported/issued in ACM
data "aws_acm_certificate" "app" {
  domain      = "*.chargebee-labs.com"
  statuses    = ["ISSUED"]
  most_recent = true
}

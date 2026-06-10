data "aws_route53_zone" "parent" {
  name = "${local.parent_zone}."
}

# Reuse the pre-existing wildcard certificate (*.localcblabs.com) imported/issued
# in ACM. The Route53 zone isn't publicly resolvable, so DNS validation of a
# brand-new cert from Terraform isn't viable — this stack just references it.
data "aws_acm_certificate" "app" {
  domain      = "*.${local.parent_zone}"
  statuses    = ["ISSUED"]
  most_recent = true
}

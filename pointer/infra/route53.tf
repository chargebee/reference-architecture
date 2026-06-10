resource "aws_route53_record" "app" {
  zone_id = data.aws_route53_zone.parent.zone_id
  name    = local.domain
  type    = "A"

  alias {
    name                   = aws_lb.app.dns_name
    zone_id                = aws_lb.app.zone_id
    evaluate_target_health = true
  }
}

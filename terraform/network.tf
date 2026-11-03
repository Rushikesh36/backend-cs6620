# Dedicated VPC for the scanner tasks and the DAST test app (docs/architecture.md section 4).
# Private subnets only: no internet gateway, no NAT gateway, no internet route, no public IPs.
# The tasks reach AWS through VPC endpoints. Lambdas run outside this VPC.

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  az_names = slice(data.aws_availability_zones.available.names, 0, var.az_count)
}

resource "aws_vpc" "main" {
  cidr_block = var.vpc_cidr
  # Both are needed so the interface endpoints' private DNS names resolve inside the VPC.
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "${local.prefix}-vpc" }
}

# One /24 per AZ, carved from the VPC range. Nothing here is reachable from the internet.
resource "aws_subnet" "private" {
  count = var.az_count

  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index)
  availability_zone       = local.az_names[count.index]
  map_public_ip_on_launch = false

  tags = { Name = "${local.prefix}-private-${local.az_names[count.index]}" }
}

# No `route` blocks on purpose: the only routes are the VPC's own and the S3 gateway endpoint's.
resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id

  tags = { Name = "${local.prefix}-private" }
}

resource "aws_route_table_association" "private" {
  count = var.az_count

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

# ---------- Security groups ----------
# Rules are separate resources, so the groups can refer to each other without a cycle.

resource "aws_security_group" "scanner" {
  name        = "${local.prefix}-scanner"
  description = "Scanner tasks: no inbound at all"
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${local.prefix}-scanner" }
}

resource "aws_security_group" "test_app" {
  name        = "${local.prefix}-test-app"
  description = "DAST test app: inbound only from the scanner"
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${local.prefix}-test-app" }
}

resource "aws_security_group" "endpoints" {
  name        = "${local.prefix}-endpoints"
  description = "VPC interface endpoints: HTTPS from the scanner and the test app"
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${local.prefix}-endpoints" }
}

# Scanner: egress to the test app (the DAST target)...
resource "aws_vpc_security_group_egress_rule" "scanner_to_test_app" {
  security_group_id            = aws_security_group.scanner.id
  referenced_security_group_id = aws_security_group.test_app.id
  ip_protocol                  = "tcp"
  from_port                    = var.test_app_port
  to_port                      = var.test_app_port
  description                  = "Scanner to the DAST test app"
}

# ...to the endpoints (ECR, CloudWatch Logs)...
resource "aws_vpc_security_group_egress_rule" "scanner_to_endpoints" {
  security_group_id            = aws_security_group.scanner.id
  referenced_security_group_id = aws_security_group.endpoints.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "Scanner to the interface endpoints"
}

# ...and to S3 through the gateway endpoint's prefix list.
resource "aws_vpc_security_group_egress_rule" "scanner_to_s3" {
  security_group_id = aws_security_group.scanner.id
  prefix_list_id    = aws_vpc_endpoint.s3.prefix_list_id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "Scanner to S3 (uploads and reports buckets, ECR image layers)"
}

# Test app: inbound only from the scanner, only on the app port.
resource "aws_vpc_security_group_ingress_rule" "test_app_from_scanner" {
  security_group_id            = aws_security_group.test_app.id
  referenced_security_group_id = aws_security_group.scanner.id
  ip_protocol                  = "tcp"
  from_port                    = var.test_app_port
  to_port                      = var.test_app_port
  description                  = "Scanner to the app"
}

# The test app pulls its image (ECR) and writes logs, so it needs the endpoints and S3 too.
resource "aws_vpc_security_group_egress_rule" "test_app_to_endpoints" {
  security_group_id            = aws_security_group.test_app.id
  referenced_security_group_id = aws_security_group.endpoints.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "Test app to the interface endpoints"
}

resource "aws_vpc_security_group_egress_rule" "test_app_to_s3" {
  security_group_id = aws_security_group.test_app.id
  prefix_list_id    = aws_vpc_endpoint.s3.prefix_list_id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "Test app to S3 (ECR image layers)"
}

# Endpoints: inbound 443 from the scanner and the test app. Nothing else.
resource "aws_vpc_security_group_ingress_rule" "endpoints_from_scanner" {
  security_group_id            = aws_security_group.endpoints.id
  referenced_security_group_id = aws_security_group.scanner.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "HTTPS from the scanner"
}

resource "aws_vpc_security_group_ingress_rule" "endpoints_from_test_app" {
  security_group_id            = aws_security_group.endpoints.id
  referenced_security_group_id = aws_security_group.test_app.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "HTTPS from the test app"
}

# ---------- VPC endpoints ----------

# S3 gateway endpoint: free. Also carries the ECR image layers.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private.id]

  tags = { Name = "${local.prefix}-s3" }
}

# Interface endpoints cost money per hour per AZ, so each one lives in a single AZ.
# Tasks in the other AZs still reach it, because private DNS resolves to this one address.
locals {
  interface_endpoints = toset(["ecr.api", "ecr.dkr", "logs"])
}

resource "aws_vpc_endpoint" "interface" {
  for_each = local.interface_endpoints

  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.${var.region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = [aws_subnet.private[0].id]
  security_group_ids  = [aws_security_group.endpoints.id]
  private_dns_enabled = true

  tags = { Name = "${local.prefix}-${each.key}" }
}

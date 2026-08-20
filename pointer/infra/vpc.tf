resource "aws_vpc" "main" {
  cidr_block           = local.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name = "${local.name_prefix}-vpc"
  }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "${local.name_prefix}-igw"
  }
}

resource "aws_subnet" "public" {
  count                   = local.az_count
  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(local.vpc_cidr, 8, count.index)
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = true

  tags = {
    Name = "${local.name_prefix}-public-${local.azs[count.index]}"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name = "${local.name_prefix}-public-rt"
  }
}

resource "aws_route_table_association" "public" {
  count          = local.az_count
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# A VPC-attached Lambda does not receive a public IP, even in a public subnet.
# Private subnets route through one NAT gateway so the worker can reach
# Chargebee, SQS, and Secrets Manager while also reaching private RDS/Redis.
# One NAT keeps this POC affordable; use one per AZ for production resilience.
resource "aws_subnet" "lambda_private" {
  count = local.lambda_worker_enabled ? local.az_count : 0

  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(local.vpc_cidr, 8, local.az_count + count.index)
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = false

  tags = {
    Name = "${local.name_prefix}-lambda-private-${local.azs[count.index]}"
  }
}

resource "aws_eip" "lambda_nat" {
  count = local.lambda_worker_enabled ? 1 : 0

  domain = "vpc"

  tags = {
    Name = "${local.name_prefix}-lambda-nat-eip"
  }
}

resource "aws_nat_gateway" "lambda" {
  count = local.lambda_worker_enabled ? 1 : 0

  allocation_id = aws_eip.lambda_nat[0].id
  subnet_id     = aws_subnet.public[0].id

  tags = {
    Name = "${local.name_prefix}-lambda-nat"
  }

  depends_on = [aws_internet_gateway.main]
}

resource "aws_route_table" "lambda_private" {
  count = local.lambda_worker_enabled ? 1 : 0

  vpc_id = aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.lambda[0].id
  }

  tags = {
    Name = "${local.name_prefix}-lambda-private-rt"
  }
}

resource "aws_route_table_association" "lambda_private" {
  count = local.lambda_worker_enabled ? local.az_count : 0

  subnet_id      = aws_subnet.lambda_private[count.index].id
  route_table_id = aws_route_table.lambda_private[0].id
}

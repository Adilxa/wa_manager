#!/bin/bash

# !:@8?B 02B><0B8G5A:>3> 45?;>O WhatsApp Manager =0 VPS Ubuntu
# A?>;L7>20=85: bash deploy.sh

set -e  # @5@20BL 2K?>;=5=85 ?@8 ;N1>9 >H81:5

echo "================================"
echo "WhatsApp Manager - Deployment"
echo "================================"
echo ""

# @>25@:0 =0;8G8O Docker
if ! command -v docker &> /dev/null; then
    echo "Docker =5 CAB0=>2;5=. #AB0=02;8205<..."
    curl -fsSL https://get.docker.com -o get-docker.sh
    sudo sh get-docker.sh
    sudo usermod -aG docker $USER
    rm get-docker.sh
    echo "Docker CAB0=>2;5=!"
else
    echo " Docker C65 CAB0=>2;5="
fi

# @>25@:0 =0;8G8O Docker Compose
if ! command -v docker-compose &> /dev/null; then
    echo "Docker Compose =5 CAB0=>2;5=. #AB0=02;8205<..."
    sudo apt-get update
    sudo apt-get install -y docker-compose-plugin
    echo "Docker Compose CAB0=>2;5=!"
else
    echo " Docker Compose C65 CAB0=>2;5="
fi

echo ""
echo "================================"
echo "0AB@>9:0 ?5@5<5==KE >:@C65=8O"
echo "================================"

# @>25@:0 =0;8G8O .env D09;0
if [ ! -f .env ]; then
    echo "$09; .env =5 =0945=. !>7405< 87 .env.example..."

    if [ -f .env.example ]; then
        cp .env.example .env
        echo ""
        echo "   : B@540:B8@C9B5 D09; .env ?5@54 ?@>4>;65=85<!"
        echo "   5>1E>48<> =0AB@>8BL:"
        echo "   - DATABASE_URL (?>4:;NG5=85 : PostgreSQL)"
        echo "   - DIRECT_URL (?@O<>5 ?>4:;NG5=85 : PostgreSQL)"
        echo "   - NEXT_PUBLIC_APP_URL (?C1;8G=K9 URL 20H53> ?@8;>65=8O)"
        echo "   - NEXT_PUBLIC_API_URL (?C1;8G=K9 URL 20H53> API)"
        echo "   - API_SECRET_KEY (A;CG09=K9 A5:@5B=K9 :;NG)"
        echo ""
        read -p "06<8B5 Enter ?>A;5 @540:B8@>20=8O .env D09;0..."
    else
        echo "L $09; .env.example =5 =0945=!"
        exit 1
    fi
else
    echo " $09; .env =0945="
fi

echo ""
echo "================================"
echo "AB0=>2:0 AB0@KE :>=B59=5@>2"
echo "================================"

# AB0=02;8205< 8 C40;O5< AB0@K5 :>=B59=5@K
if [ "$(docker ps -q -f name=wa-manager)" ]; then
    echo "AB0=02;8205< @01>B0NI85 :>=B59=5@K..."
    docker-compose down
else
    echo " 5B @01>B0NI8E :>=B59=5@>2"
fi

echo ""
echo "================================"
echo "!1>@:0 8 70?CA: :>=B59=5@>2"
echo "================================"

# !>18@05< 8 70?CA:05< :>=B59=5@K
echo "!>18@05< Docker >1@07..."
docker-compose build --no-cache

echo "0?CA:05< :>=B59=5@K..."
docker-compose up -d

echo ""
echo "================================"
echo "@>25@:0 AB0BCA0"
echo "================================"

# 45< =5A:>;L:> A5:C=4 4;O 70?CA:0 :>=B59=5@>2
sleep 5

# @>25@O5< AB0BCA :>=B59=5@>2
docker-compose ps

echo ""
echo "================================"
echo "0AB@>9:0 Firewall (UFW)"
echo "================================"

if command -v ufw &> /dev/null; then
    echo "B:@K205< =5>1E>48<K5 ?>@BK..."
    sudo ufw allow 22/tcp      # SSH
    sudo ufw allow 80/tcp      # HTTP
    sudo ufw allow 443/tcp     # HTTPS
    sudo ufw allow 6000/tcp    # Next.js UI
    sudo ufw allow 6001/tcp    # WhatsApp API

    # :B828@C5< UFW 5A;8 =5 0:B825=
    sudo ufw --force enable

    echo " Firewall =0AB@>5="
    sudo ufw status
else
    echo "   UFW =5 CAB0=>2;5=.  5:><5=4C5BAO CAB0=>28BL 4;O 157>?0A=>AB8:"
    echo "   sudo apt-get install ufw"
fi

echo ""
echo "================================"
echo "5?;>9 7025@H5=!"
echo "================================"
echo ""
echo "@8;>65=85 4>ABC?=> ?> 04@5A0<:"
echo "  UI:  http://$(hostname -I | awk '{print $1}'):6000"
echo "  API: http://$(hostname -I | awk '{print $1}'):6001"
echo ""
echo ";O ?@>A<>B@0 ;>3>2:"
echo "  docker-compose logs -f"
echo ""
echo ";O >AB0=>2:8:"
echo "  docker-compose down"
echo ""
echo ";O ?5@570?CA:0:"
echo "  docker-compose restart"
echo ""
echo "    5:><5=4C5BAO =0AB@>8BL Nginx A SSL 4;O production!"
echo "   !<. 8=AB@C:F8N 2 DEPLOY.md"
echo ""

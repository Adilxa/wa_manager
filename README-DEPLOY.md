# WhatsApp Manager - KAB@K9 45?;>9 =0 VPS Ubuntu

## 0AB@>5==K5 ?>@BK
- **6000** - Next.js UI (251-8=B5@D59A)
- **6001** - WhatsApp API (A5@25@)

## KAB@K9 AB0@B

### 1. >4:;NG8B5AL : VPS
```bash
ssh user@your-server-ip
```

### 2. ;>=8@C9B5 @5?>78B>@89
```bash
git clone <your-repo-url> wa-manager
cd wa-manager
```

### 3. 0AB@>9B5 .env
```bash
cp .env.example .env
nano .env
```

1O70B5;L=> 87<5=8B5:
- `DATABASE_URL` - ?>4:;NG5=85 : PostgreSQL
- `DIRECT_URL` - ?@O<>5 ?>4:;NG5=85 : PostgreSQL
- `NEXT_PUBLIC_APP_URL` - http://20H-ip:6000
- `NEXT_PUBLIC_API_URL` - http://20H-ip:6001
- `API_SECRET_KEY` - A;CG09=K9 A5:@5B=K9 :;NG

### 4. 0?CAB8B5 02B><0B8G5A:89 45?;>9
```bash
chmod +x deploy.sh
bash deploy.sh
```

### 5. @>25@LB5 @01>BC
```bash
# !B0BCA :>=B59=5@>2
docker-compose ps

# >38
docker-compose logs -f

# "5AB UI
curl http://localhost:6000

# "5AB API
curl http://localhost:6001/api/accounts
```

## >ABC? : ?@8;>65=8N

>A;5 CA?5H=>3> 45?;>O ?@8;>65=85 1C45B 4>ABC?=>:
- **UI**: http://20H-ip-A5@25@0:6000
- **API**: http://20H-ip-A5@25@0:6001

## #?@02;5=85

```bash
# @>A<>B@ ;>3>2
docker-compose logs -f

# 5@570?CA:
docker-compose restart

# AB0=>2:0
docker-compose down

# 1=>2;5=85
git pull
docker-compose up -d --build
```

## 'B> 45;05B deploy.sh?

1. @>25@O5B 8 CAB0=02;8205B Docker
2. @>25@O5B 8 CAB0=02;8205B Docker Compose
3. !>7405B .env 87 ?@8<5@0
4. !>18@05B Docker >1@07
5. 0?CA:05B :>=B59=5@K
6. 0AB@08205B firewall (>B:@K205B ?>@BK 22, 80, 443, 6000, 6001)

## "@51>20=8O

- Ubuntu 18.04+ (8;8 4@C30O Linux A8AB5<0)
- 8=8<C< 2GB RAM
- PostgreSQL 1070 40==KE (<>6=> 8A?>;L7>20BL Supabase)

## @>1;5<K?

A;8 2>7=8:;8 ?@>1;5<K:
1. @>25@LB5 ;>38: `docker-compose logs -f`
2. @>25@LB5 ?>@BK: `sudo lsof -i :6000` 8 `sudo lsof -i :6001`
3. @>25@LB5 .env D09;
4. #1548B5AL GB>  4>ABC?=0

## >4@>1=0O 4>:C<5=B0F8O

!<. [DEPLOY.md](./DEPLOY.md) 4;O ?>;=>9 8=AB@C:F88 2:;NG0O:
- 0AB@>9:C Nginx A SSL
-  CG=>9 45?;>9
-  5H5=85 ?@>1;5<
-  575@2=>5 :>?8@>20=85

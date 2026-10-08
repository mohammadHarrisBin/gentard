//+------------------------------------------------------------------+
//| AI_Bridge_EA.mq5 - thin client. Runs on a Windows VPS with MT5.  |
//| Whitelist your Railway URL: Tools>Options>Expert Advisors.       |
//+------------------------------------------------------------------+
#property strict
#include <Trade\Trade.mqh>

input string InpServerUrl    = "https://YOUR-APP.up.railway.app/api/decide";
input string InpEaKey        = "";
input int    InpIntervalSec  = 5;
input double InpLots         = 0.01;
input int    InpMinSL        = 50;
input int    InpMaxSL        = 300;
input int    InpMinTP        = 50;
input int    InpMaxTP        = 600;
input int    InpMaxSpread    = 25;
input int    InpMaxHoldSec   = 300;
input int    InpMaxPositions = 1;
input double InpDailyLossPct = 3.0;
input long   InpMagic        = 777001;

CTrade trade; int atrH; datetime last=0; double dayEq=0; int dayN=-1;

int OnInit(){
  if(StringLen(InpEaKey)==0){Print("Set InpEaKey");return INIT_PARAMETERS_INCORRECT;}
  trade.SetExpertMagicNumber(InpMagic); trade.SetTypeFillingBySymbol(_Symbol);
  atrH=iATR(_Symbol,PERIOD_M1,14); EventSetTimer(1); return INIT_SUCCEEDED;
}
void OnDeinit(const int r){EventKillTimer();}

double PnlAll(){
  double p=0; if(!HistorySelect(0,TimeCurrent())) return 0;
  for(int i=0;i<HistoryDealsTotal();i++){ulong t=HistoryDealGetTicket(i);
    if(HistoryDealGetInteger(t,DEAL_MAGIC)!=InpMagic) continue;
    p+=HistoryDealGetDouble(t,DEAL_PROFIT)+HistoryDealGetDouble(t,DEAL_SWAP)+HistoryDealGetDouble(t,DEAL_COMMISSION);}
  return p;
}
int MyPos(){int n=0;for(int i=0;i<PositionsTotal();i++){PositionGetTicket(i);
  if(PositionGetString(POSITION_SYMBOL)==_Symbol&&PositionGetInteger(POSITION_MAGIC)==InpMagic)n++;}return n;}
void Sweep(bool all){
  for(int i=PositionsTotal()-1;i>=0;i--){ulong t=PositionGetTicket(i);
    if(PositionGetString(POSITION_SYMBOL)!=_Symbol||PositionGetInteger(POSITION_MAGIC)!=InpMagic) continue;
    if(all||TimeCurrent()-(datetime)PositionGetInteger(POSITION_TIME)>=InpMaxHoldSec) trade.PositionClose(t);}
}
string Str(const string j,const string k){
  int p=StringFind(j,"\""+k+"\""); if(p<0)return ""; p=StringFind(j,":",p); if(p<0)return ""; p++;
  while(StringGetCharacter(j,p)==' ')p++; if(StringGetCharacter(j,p)!='"')return ""; p++;
  string o=""; for(int i=p;i<StringLen(j);i++){ushort c=StringGetCharacter(j,i); if(c=='"')break; o+=ShortToString(c);} return o;}
double Num(const string j,const string k){
  int p=StringFind(j,"\""+k+"\""); if(p<0)return 0; p=StringFind(j,":",p); if(p<0)return 0; p++;
  string n=""; for(int i=p;i<StringLen(j);i++){ushort c=StringGetCharacter(j,i);
    if((c>='0'&&c<='9')||c=='-'||c=='.')n+=ShortToString(c); else if(c!=' ')break;} return StringToDouble(n);}

void OnTimer(){
  MqlDateTime t; TimeToStruct(TimeCurrent(),t);
  if(t.day_of_year!=dayN){dayN=t.day_of_year; dayEq=AccountInfoDouble(ACCOUNT_EQUITY);}
  Sweep(false);
  double eq=AccountInfoDouble(ACCOUNT_EQUITY);
  if(dayEq>0&&(dayEq-eq)/dayEq*100.0>=InpDailyLossPct){Sweep(true);return;}
  if(TimeCurrent()-last<InpIntervalSec) return; last=TimeCurrent();

  double atr[]; ArraySetAsSeries(atr,true); double atrP=0; if(CopyBuffer(atrH,0,0,1,atr)>0) atrP=atr[0]/_Point;
  MqlRates r[]; ArraySetAsSeries(r,true); int n=CopyRates(_Symbol,PERIOD_M1,0,10,r);
  string bars=""; for(int i=0;i<n;i++) bars+=DoubleToString(r[i].open,_Digits)+"/"+DoubleToString(r[i].high,_Digits)+"/"+
      DoubleToString(r[i].low,_Digits)+"/"+DoubleToString(r[i].close,_Digits)+" ";
  string pos="none"; for(int i=0;i<PositionsTotal();i++){PositionGetTicket(i);
    if(PositionGetString(POSITION_SYMBOL)!=_Symbol||PositionGetInteger(POSITION_MAGIC)!=InpMagic) continue;
    if(pos=="none")pos=""; pos+=(PositionGetInteger(POSITION_TYPE)==POSITION_TYPE_BUY?"BUY":"SELL")+" pnl="+DoubleToString(PositionGetDouble(POSITION_PROFIT),2)+" ";}

  string body="{\"symbol\":\""+_Symbol+"\",\"bid\":"+DoubleToString(SymbolInfoDouble(_Symbol,SYMBOL_BID),_Digits)+
    ",\"ask\":"+DoubleToString(SymbolInfoDouble(_Symbol,SYMBOL_ASK),_Digits)+
    ",\"spread_pts\":"+IntegerToString((int)SymbolInfoInteger(_Symbol,SYMBOL_SPREAD))+
    ",\"atr_pts\":"+DoubleToString(atrP,0)+",\"bars_ohlc_newest_first\":\""+bars+"\",\"positions\":\""+pos+
    "\",\"equity\":"+DoubleToString(eq,2)+",\"balance\":"+DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE),2)+
    ",\"pnl_all\":"+DoubleToString(PnlAll(),2)+"}";

  char data[],res[]; string rh;
  int len=StringToCharArray(body,data,0,StringLen(body),CP_UTF8);
  string hdr="Content-Type: application/json\r\nx-key: "+InpEaKey+"\r\n";
  int code=WebRequest("POST",InpServerUrl,hdr,10000,data,res,rh);
  if(code!=200){Print("Server error ",code," err=",GetLastError());return;}
  string j=CharArrayToString(res,0,WHOLE_ARRAY,CP_UTF8);
  string a=Str(j,"action"); Print("AI: ",j);
  if(a=="CLOSE"){Sweep(true);return;}
  if(a!="BUY"&&a!="SELL") return;
  if(MyPos()>=InpMaxPositions||SymbolInfoInteger(_Symbol,SYMBOL_SPREAD)>InpMaxSpread) return;
  int lv=(int)SymbolInfoInteger(_Symbol,SYMBOL_TRADE_STOPS_LEVEL)+1;
  int sl=(int)MathMax(lv,MathMax(InpMinSL,MathMin(InpMaxSL,(int)Num(j,"sl_points"))));
  int tp=(int)MathMax(lv,MathMax(InpMinTP,MathMin(InpMaxTP,(int)Num(j,"tp_points"))));
  double ask=SymbolInfoDouble(_Symbol,SYMBOL_ASK),bid=SymbolInfoDouble(_Symbol,SYMBOL_BID);
  if(a=="BUY") trade.Buy(InpLots,_Symbol,ask,NormalizeDouble(ask-sl*_Point,_Digits),NormalizeDouble(ask+tp*_Point,_Digits),"AI");
  else trade.Sell(InpLots,_Symbol,bid,NormalizeDouble(bid+sl*_Point,_Digits),NormalizeDouble(bid-tp*_Point,_Digits),"AI");
}
